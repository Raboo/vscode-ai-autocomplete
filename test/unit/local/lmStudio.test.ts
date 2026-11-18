import { describe, expect, it } from 'vitest';
import { LocalRuntimeError } from '../../../src/local/llamaServer';
import { defaultExec, LmStudio, type ExecLike } from '../../../src/local/lmStudio';

type Reply = { code?: number; stdout?: string; stderr?: string };

/** A recording fake: each call takes the next reply for its subcommand. */
function fake(replies: Record<string, Reply[]>) {
  const calls: { cmd: string; args: string[]; timeoutMs: number }[] = [];
  const exec: ExecLike = async (cmd, args, o) => {
    calls.push({ cmd, args, timeoutMs: o.timeoutMs });
    const key = args.slice(0, args[0] === 'server' ? 2 : 1).join(' ');
    const r = replies[key]?.shift();
    if (!r) throw new Error(`unexpected call: ${args.join(' ')}`);
    return { code: r.code ?? 0, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  };
  return { exec, calls, lms: new LmStudio('/bin/lms', exec) };
}

const FILE = 'sweep-next-edit-7b.Q4_K_M.gguf';
const REPO = 'sweepai/sweep-next-edit-7B';
const listing = (entries: object[]) => ({ stdout: JSON.stringify(entries) });
const entry = { modelKey: 'sweep-next-edit-7b', path: `${REPO}/${FILE}`, format: 'gguf', sizeBytes: 1 };

describe('LmStudio.importModel', () => {
  it('returns the listed key without importing', async () => {
    const f = fake({ ls: [listing([{ modelKey: 'x', path: 'a/b/c.gguf' }, entry])] });
    expect(await f.lms.importModel(FILE, REPO)).toBe('sweep-next-edit-7b');
    expect(f.calls.map((c) => c.args)).toEqual([['ls', '--json']]);
    expect(f.calls[0]?.cmd).toBe('/bin/lms');
  });

  it('matches a downloaded file by its base name', async () => {
    const f = fake({ ls: [listing([entry])] });
    expect(await f.lms.importModel(`/models/dl/${FILE}`, REPO)).toBe('sweep-next-edit-7b');
  });

  it('imports with the exact arguments, lists again and returns the new key', async () => {
    const f = fake({ ls: [listing([]), listing([entry])], import: [{}] });
    expect(await f.lms.importModel(`/models/${FILE}`, REPO)).toBe('sweep-next-edit-7b');
    expect(f.calls.map((c) => c.args)).toEqual([
      ['ls', '--json'],
      ['import', '--hard-link', '-y', '--user-repo', REPO, `/models/${FILE}`],
      ['ls', '--json'],
    ]);
    expect(f.calls[1]?.timeoutMs).toBe(10 * 60_000);
    expect(f.calls[0]?.timeoutMs).toBe(30_000);
  });

  it('throws when the model is not listed after the import', async () => {
    const f = fake({ ls: [listing([]), listing([])], import: [{}] });
    await expect(f.lms.importModel(FILE, REPO)).rejects.toThrow(LocalRuntimeError);
  });

  it('throws on invalid JSON, a non-list and an entry without a modelKey', async () => {
    await expect(fake({ ls: [{ stdout: 'nope' }] }).lms.importModel(FILE, REPO)).rejects.toThrow(/not JSON/);
    await expect(fake({ ls: [{ stdout: '{}' }] }).lms.importModel(FILE, REPO)).rejects.toThrow(/unexpected list/);
    await expect(
      fake({ ls: [listing([{ path: `${REPO}/${FILE}` }])] }).lms.importModel(FILE, REPO),
    ).rejects.toThrow(/modelKey/);
  });
});

describe('LmStudio.ensureServer', () => {
  it('returns the port of a running server', async () => {
    const f = fake({ 'server status': [{ stdout: '{"running":true,"port":1234}' }] });
    expect(await f.lms.ensureServer()).toBe(1234);
    expect(f.calls.map((c) => c.args)).toEqual([['server', 'status', '--json']]);
  });

  it('starts a stopped server and reads the status again', async () => {
    const f = fake({
      'server status': [{ stdout: '{"running":false,"port":1234}' }, { stdout: '{"running":true,"port":4321}' }],
      'server start': [{}],
    });
    expect(await f.lms.ensureServer()).toBe(4321);
    expect(f.calls.map((c) => c.args)).toEqual([
      ['server', 'status', '--json'],
      ['server', 'start'],
      ['server', 'status', '--json'],
    ]);
  });

  it('throws when the server still is not running after the start', async () => {
    const f = fake({ 'server status': [{ stdout: '{"running":false}' }, { stdout: '{"running":false}' }], 'server start': [{}] });
    await expect(f.lms.ensureServer()).rejects.toThrow(LocalRuntimeError);
  });

  it('throws on a status without the running flag or the port', async () => {
    await expect(fake({ 'server status': [{ stdout: '{"port":1}' }] }).lms.ensureServer()).rejects.toThrow(LocalRuntimeError);
    await expect(fake({ 'server status': [{ stdout: '{"running":true}' }] }).lms.ensureServer()).rejects.toThrow(/no port/);
  });
});

describe('LmStudio.load', () => {
  it('skips loading when the identifier is already loaded', async () => {
    const f = fake({ ps: [listing([{ identifier: 'ai-autocomplete-x', modelKey: 'k', path: 'p', contextLength: 4096 }])] });
    await f.lms.load('k', 8192, 'ai-autocomplete-x');
    expect(f.calls.map((c) => c.args)).toEqual([['ps', '--json']]);
  });

  it('runs the exact load arguments otherwise', async () => {
    const f = fake({ ps: [listing([{ identifier: 'other' }])], load: [{}] });
    await f.lms.load('sweep-next-edit-7b', 8192, 'ai-autocomplete-x');
    expect(f.calls.map((c) => c.args)).toEqual([
      ['ps', '--json'],
      ['load', 'sweep-next-edit-7b', '-c', '8192', '--identifier', 'ai-autocomplete-x', '-y'],
    ]);
    expect(f.calls[1]?.timeoutMs).toBe(5 * 60_000);
  });
});

describe('failures', () => {
  it('a non-zero exit throws LocalRuntimeError with the first 500 characters of stderr', async () => {
    const f = fake({ ps: [listing([])], load: [{ code: 1, stderr: 'x'.repeat(800) }] });
    const err = await f.lms.load('k', 1, 'i').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LocalRuntimeError);
    const message = (err as Error).message;
    expect(message).toContain('x'.repeat(500));
    expect(message).not.toContain('x'.repeat(501));
    expect(message).toContain('exit 1');
  });

  it('a failing ls throws with its stderr', async () => {
    const f = fake({ ls: [{ code: 2, stderr: 'LM Studio is not installed' }] });
    await expect(f.lms.importModel(FILE, REPO)).rejects.toThrow(/LM Studio is not installed/);
  });
});

describe('defaultExec', () => {
  it('resolves with the exit code, stdout and stderr instead of rejecting', async () => {
    const ok = await defaultExec(process.execPath, ['-e', 'process.stdout.write("hi")'], { timeoutMs: 10_000 });
    expect(ok).toEqual({ code: 0, stdout: 'hi', stderr: '' });
    const bad = await defaultExec(process.execPath, ['-e', 'process.stderr.write("boom");process.exit(3)'], { timeoutMs: 10_000 });
    expect(bad.code).toBe(3);
    expect(bad.stderr).toBe('boom');
  });

  it('turns a spawn failure into LocalRuntimeError', async () => {
    const err = await defaultExec('/nonexistent/lms-binary', [], { timeoutMs: 1000 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LocalRuntimeError);
    expect((err as Error).message).toMatch(/^could not run lms: /);
  });

  it('stops a command that exceeds its timeout', async () => {
    const r = await defaultExec(process.execPath, ['-e', 'setTimeout(()=>{},30000)'], { timeoutMs: 200 });
    expect(r.code).not.toBe(0);
    expect(r.stderr).toMatch(/timed out/);
  });
});
