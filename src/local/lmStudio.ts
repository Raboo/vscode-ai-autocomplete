import { execFile } from 'node:child_process';
import { LocalRuntimeError } from './llamaServer';

export type ExecLike = (
  cmd: string,
  args: string[],
  o: { timeoutMs: number },
) => Promise<{ code: number; stdout: string; stderr: string }>;

const QUICK_MS = 30_000;
const IMPORT_MS = 10 * 60_000;
const LOAD_MS = 5 * 60_000;
const MAX_BUFFER = 10 * 1024 * 1024;
const STDERR_CHARS = 500;

/** Runs a command with an argument array (never a shell). A non-zero exit resolves with its code. */
export const defaultExec: ExecLike = (cmd, args, o) =>
  new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: o.timeoutMs, maxBuffer: MAX_BUFFER, encoding: 'utf8' }, (err, stdout, stderr) => {
      if (!err) {
        resolve({ code: 0, stdout, stderr });
        return;
      }
      const e = err as NodeJS.ErrnoException & { killed?: boolean };
      if (typeof e.code === 'number') {
        resolve({ code: e.code, stdout, stderr });
      } else if (e.killed) {
        resolve({ code: 1, stdout, stderr: stderr || `timed out after ${Math.round(o.timeoutMs / 1000)} s` });
      } else {
        reject(new LocalRuntimeError(`could not run lms: ${e.message}`));
      }
    });
  });

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function lastSegment(file: string): string {
  return file.split(/[\\/]/).pop() ?? file;
}

/** Drives LM Studio through its `lms` command line. */
export class LmStudio {
  constructor(
    private readonly lms: string,
    private readonly exec: ExecLike,
  ) {}

  private async run(args: string[], timeoutMs = QUICK_MS): Promise<string> {
    const r = await this.exec(this.lms, args, { timeoutMs });
    if (r.code !== 0) {
      const detail = r.stderr.trim().slice(0, STDERR_CHARS);
      throw new LocalRuntimeError(`lms ${args[0]} failed (exit ${r.code})${detail ? `: ${detail}` : '.'}`);
    }
    return r.stdout;
  }

  private async runJson(args: string[]): Promise<unknown> {
    const out = await this.run(args);
    try {
      return JSON.parse(out);
    } catch {
      throw new LocalRuntimeError(`lms ${args[0]} returned output that is not JSON.`);
    }
  }

  private async runJsonArray(args: string[]): Promise<Record<string, unknown>[]> {
    const data = await this.runJson(args);
    if (!Array.isArray(data) || !data.every(isRecord)) {
      throw new LocalRuntimeError(`lms ${args[0]} returned an unexpected list.`);
    }
    return data;
  }

  private async findModelKey(path: string): Promise<string | undefined> {
    const entries = await this.runJsonArray(['ls', '--json']);
    const hit = entries.find((e) => e['path'] === path);
    if (!hit) return undefined;
    const key = hit['modelKey'];
    if (typeof key !== 'string' || key === '') {
      throw new LocalRuntimeError('lms ls returned an entry without a modelKey.');
    }
    return key;
  }

  /** Imports a downloaded GGUF (hard link, no copy where possible) and returns its LM Studio model key. */
  async importModel(file: string, repo: string): Promise<string> {
    const path = `${repo}/${lastSegment(file)}`;
    const existing = await this.findModelKey(path);
    if (existing !== undefined) return existing;
    await this.run(['import', '--hard-link', '-y', '--user-repo', repo, file], IMPORT_MS);
    const imported = await this.findModelKey(path);
    if (imported === undefined) {
      throw new LocalRuntimeError('LM Studio did not list the model after importing it.');
    }
    return imported;
  }

  private async serverPort(): Promise<number | undefined> {
    const status = await this.runJson(['server', 'status', '--json']);
    if (!isRecord(status) || typeof status['running'] !== 'boolean') {
      throw new LocalRuntimeError('lms server status returned an unexpected answer.');
    }
    if (!status['running']) return undefined;
    const port = status['port'];
    if (typeof port !== 'number' || !Number.isInteger(port) || port <= 0) {
      throw new LocalRuntimeError('lms server status returned no port.');
    }
    return port;
  }

  /** Makes sure LM Studio's server runs and returns its port. */
  async ensureServer(): Promise<number> {
    const running = await this.serverPort();
    if (running !== undefined) return running;
    await this.run(['server', 'start']);
    const started = await this.serverPort();
    if (started === undefined) {
      throw new LocalRuntimeError('LM Studio server is not running after lms server start.');
    }
    return started;
  }

  /** Loads a model under an identifier unless that identifier is already loaded. */
  async load(modelKey: string, contextTokens: number, identifier: string): Promise<void> {
    const loaded = await this.runJsonArray(['ps', '--json']);
    if (loaded.some((e) => e['identifier'] === identifier)) return;
    await this.run(['load', modelKey, '-c', String(contextTokens), '--identifier', identifier, '-y'], LOAD_MS);
  }
}
