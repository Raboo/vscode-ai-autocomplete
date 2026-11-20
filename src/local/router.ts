// llama-server router mode: the presets file the extension writes, the arguments to start it and a small client for its HTTP API.
import { isAbsolute } from 'node:path';
import { extraArgsToPreset } from './extraArgs';
import type { LocalModel } from './modelList';

const LINE_BREAK = /[\r\n\u0085\u2028\u2029]/;

function safe(text: string, what: string): string {
  if (LINE_BREAK.test(text)) throw new Error(`presets: ${what} contains a line break`);
  return text;
}

function sectionName(name: string): string {
  if (name === '' || /[[\]]/.test(name)) throw new Error('presets: unsafe model name');
  return safe(name, 'model name');
}

/** The presets.ini text for the given models (callers pass the downloaded, not hidden ones). */
export function renderPresets(models: LocalModel[], filePath: (m: LocalModel) => string, o: { speculative: boolean }): string {
  const lines = ['version = 1', '', '[*]', 'ngl = 99', 'fa = on', 'cache-reuse = 256'];
  if (o.speculative) lines.push('spec-type = ngram-cache,ngram-simple');
  for (const m of models) {
    if (!Number.isInteger(m.contextTokens) || m.contextTokens < 1) throw new Error('presets: context must be a positive integer');
    const file = safe(filePath(m), 'path');
    if (!isAbsolute(file)) throw new Error('presets: model path must be absolute');
    const slots = m.uses.includes('nextEdit') ? 2 : 1;
    lines.push('', `[${sectionName(m.name)}]`, `model = ${file}`, `c = ${m.contextTokens * slots}`, `np = ${slots}`);
    for (const [key, value] of extraArgsToPreset(m.extraArgs)) {
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(key)) throw new Error('presets: unsafe key');
      if (/^[[;]/.test(value)) throw new Error('presets: unsafe value');
      lines.push(`${key} = ${safe(value, 'value')}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

export function routerArgs(o: { presetsPath: string; modelsMax: number; port: number }): string[] {
  return ['--models-preset', o.presetsPath, '--models-max', String(o.modelsMax), '--host', '127.0.0.1', '--port', String(o.port), '--no-webui'];
}

export function supportsRouter(helpText: string): boolean {
  return helpText.includes('--models-preset');
}

/** Whether this llama-server knows n-gram speculative decoding (`--spec-type` with `ngram-cache` in its help). */
export function supportsSpeculative(helpText: string): boolean {
  return helpText.includes('--spec-type') && helpText.includes('ngram-cache');
}

export interface RouterModel {
  id: string;
  state: 'unloaded' | 'loading' | 'loaded' | 'sleeping' | 'failed';
}

const SHORT_MS = 5000;
const LOAD_MS = 120000;

function stateOf(status: unknown): RouterModel['state'] {
  const s = (status ?? {}) as { value?: unknown; failed?: unknown };
  if (s.failed === true) return 'failed';
  return s.value === 'loaded' || s.value === 'loading' || s.value === 'sleeping' ? s.value : 'unloaded';
}

export class RouterClient {
  private readonly base: string;

  constructor(
    baseUrl: string,
    private readonly fetchFn: typeof fetch = fetch,
  ) {
    this.base = baseUrl.replace(/\/+$/, '');
  }

  private async call(path: string, timeoutMs: number, body?: unknown): Promise<Response> {
    let res: Response;
    try {
      res = await this.fetchFn(`${this.base}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: body === undefined ? undefined : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new Error('router request failed');
    }
    if (!res.ok) throw new Error(`router request failed (${res.status})`);
    return res;
  }

  async isRouter(): Promise<boolean> {
    try {
      const props = (await (await this.call('/props', SHORT_MS)).json()) as { role?: unknown };
      return props.role === 'router';
    } catch {
      return false;
    }
  }

  async models(): Promise<RouterModel[]> {
    const res = await this.call('/models', SHORT_MS);
    const data = ((await res.json()) as { data?: unknown }).data;
    if (!Array.isArray(data)) return [];
    return data
      .filter((d): d is { id: string; status?: unknown } => typeof d?.id === 'string')
      .map((d) => ({ id: d.id, state: stateOf(d.status) }));
  }

  async load(name: string): Promise<void> {
    await this.call('/models/load', LOAD_MS, { model: name });
  }

  async unload(name: string): Promise<void> {
    await this.call('/models/unload', LOAD_MS, { model: name });
  }

  async reload(): Promise<void> {
    await this.call('/models?reload=1', SHORT_MS);
  }
}

/** What answers on a port: our router, a llama-server still loading (503), or neither. */
export type PortState = 'ours' | 'loading' | 'none';

/** `ours` when a router with every name answers on the port, `loading` while /health says 503, else `none`. */
export async function probeRouter(port: number, names: string[], fetchFn: typeof fetch = fetch): Promise<PortState> {
  const base = `http://127.0.0.1:${port}`;
  try {
    const health = await fetchFn(`${base}/health`, { signal: AbortSignal.timeout(SHORT_MS) });
    if (health.status === 503) return 'loading';
    if (health.status !== 200) return 'none';
    const client = new RouterClient(base, fetchFn);
    if (!(await client.isRouter())) return 'none';
    const ids = new Set((await client.models()).map((m) => m.id));
    return names.every((n) => ids.has(n)) ? 'ours' : 'none';
  } catch {
    return 'none';
  }
}
