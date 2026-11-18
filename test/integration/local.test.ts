import * as assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as vscode from 'vscode';
import type { Recipe } from '../../src/local/recipes';
import type { SetupOutcome } from '../../src/local/vscode/setup';
import { clearAsked, commitWhen, configure, registerProbe, showAtEnd, sleep, SETTLE_MS, trigger, unconfigure, waitFor } from './helpers';
import { startMockServer, type MockServer } from './mockServer';

/** The part of the extension's `activate()` result these tests use. */
interface Api {
  local?: { setRecipes(r: Recipe[] | undefined): void; rerunMigration(legacy: unknown): Promise<void> };
  localModelsPanel(): { handle(m: unknown): Promise<void>; lastState(): PageState | undefined } | undefined;
}
type PageState = import('../../src/local/page/protocol').LocalPageState;

const ROOT = join(__dirname, '..', '..', '..');
const FIXTURE = join(ROOT, 'test', 'integration', 'fixtures', 'fake-llama-server.mjs');
/** `.vscode-test.mjs` pins the user data folder; the extension's global storage is in it. */
const STORAGE = join(ROOT, '.vscode-test', 'user-data', 'User', 'globalStorage', 'raboo.ai-autocomplete');
const MODELS = join(STORAGE, 'models');
const PRESETS = join(STORAGE, 'presets.ini');
const FILE_PATH = '/files/test-model.gguf';
const BYTES = Buffer.from(Array.from({ length: 64 * 1024 }, (_, i) => (i * 31 + 7) % 256));
const BACKEND_ID = 'local';
const EXIT_ENV = 'FAKE_LLAMA_SERVER_EXIT';
const EXIT_ONCE_ENV = 'FAKE_LLAMA_SERVER_EXIT_ONCE';
const STARTS_ENV = 'FAKE_LLAMA_SERVER_STARTS';
const ARGS_ENV = 'FAKE_LLAMA_SERVER_ARGS';
const LOG_ENV = 'FAKE_LLAMA_SERVER_LOG';
/** Every setting a test may write; teardown resets them. */
const TOUCHED = ['backends', 'completions.backend', 'completions.enabled', 'completions.debounceMs', 'nextEdit.backend', 'nextEdit.enabled', 'local.llamaServerPath'];

const userBackends = (): Record<string, unknown>[] => {
  const list = vscode.workspace.getConfiguration('aiAutocomplete').inspect('backends')?.globalValue;
  return Array.isArray(list) ? (list as Record<string, unknown>[]) : [];
};
const entry = (): Record<string, unknown> | undefined => userBackends().find((e) => e.id === BACKEND_ID);
const portOf = (e: Record<string, unknown> | undefined): number => Number(new URL(String(e?.baseUrl)).port);
const setUp = (replace = false): Thenable<SetupOutcome> =>
  vscode.commands.executeCommand<SetupOutcome>('aiAutocomplete.setUpLocalModel', { recipe: 'test', ...(replace ? { replace } : {}) });
const health = async (port: number): Promise<number> => (await fetch(`http://127.0.0.1:${port}/health`)).status;
const healthy = async (port: number): Promise<boolean> => (await health(port).catch(() => 0)) === 200;
async function healthyWithin(port: number, ms: number): Promise<boolean> {
  for (const deadline = Date.now() + ms; Date.now() < deadline; await sleep(100)) if (await healthy(port)) return true;
  return false;
}

suite('Local model helper', () => {
  let mock: MockServer;
  let api: Api;
  let probe: vscode.Disposable;
  let binDir: string;
  const local = (): NonNullable<Api['local']> => {
    assert.ok(api.local, 'the test API has no local hooks (not in test mode?)');
    return api.local;
  };

  const downloads = () => mock.requests.filter((r) => r.path === FILE_PATH);

  suiteSetup(async () => {
    mock = await startMockServer({ files: { [FILE_PATH]: BYTES } });
    api = await vscode.extensions.getExtension<Api>('raboo.ai-autocomplete')!.activate();
    probe = registerProbe();
    // A copy with the executable bit, whatever mode the checkout gave the fixture.
    binDir = mkdtempSync(join(tmpdir(), 'ai-autocomplete-local-'));
    const binary = join(binDir, 'llama-server');
    copyFileSync(FIXTURE, binary);
    chmodSync(binary, 0o755);
    rmSync(join(MODELS, 'test'), { recursive: true, force: true });
    local().setRecipes([
      {
        id: 'test',
        label: 'Test Model',
        repo: 'test/test-model',
        revision: '0'.repeat(40),
        file: 'test-model.gguf',
        bytes: BYTES.length,
        sha256: createHash('sha256').update(BYTES).digest('hex'),
        license: 'MIT',
        uses: ['completions'],
        modelName: 'test-coder',
        contextTokens: 2048,
        url: `${mock.baseUrl}${FILE_PATH}`,
      },
    ]);
    await unconfigure(TOUCHED);
    await configure({ 'local.llamaServerPath': binary });
  });

  suiteTeardown(async () => {
    delete process.env[EXIT_ENV];
    delete process.env[EXIT_ONCE_ENV];
    delete process.env[STARTS_ENV];
    await vscode.commands.executeCommand('aiAutocomplete.stopLocalModels');
    local().setRecipes(undefined);
    await unconfigure(TOUCHED);
    probe.dispose();
    await mock.close();
    rmSync(binDir, { recursive: true, force: true });
    rmSync(join(MODELS, 'test'), { recursive: true, force: true });
  });

  setup(() => {
    mock.reset();
    clearAsked();
  });

  teardown(async () => {
    await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
  });

  test('setup downloads the model, starts the llama-server router, writes and selects local, and completions work', async () => {
    const out = await setUp();
    assert.ok(out?.ok, `setup failed: ${JSON.stringify(out)}`);
    assert.equal(out.backendId, BACKEND_ID);
    assert.equal(out.steps.find((s) => s.state === 'fail'), undefined, `test steps: ${JSON.stringify(out.steps)}`);
    assert.equal(downloads().length, 1, `requests: ${JSON.stringify(mock.requests.map((r) => r.path))}`);
    assert.ok(existsSync(join(MODELS, 'test', 'test-model', 'test-model.gguf')), 'the model file is not in global storage');

    const e = entry();
    assert.equal(e?.kind, 'llamacpp');
    assert.equal(e?.model, 'test-coder');
    assert.match(String(e?.baseUrl), /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.equal(vscode.workspace.getConfiguration('aiAutocomplete').get('completions.backend'), BACKEND_ID);
    assert.equal(await health(portOf(e)), 200);
    assert.match(readFileSync(PRESETS, 'utf8'), /\[test-coder\]\nmodel = .*test-model\.gguf\nc = 2048\nnp = 1\n/);

    await sleep(SETTLE_MS);
    const editor = await showAtEnd(await vscode.workspace.openTextDocument({ language: 'typescript', content: 'function add(a: number, b: number) {\n  return ' }));
    await trigger(editor);
    await commitWhen(editor, (t) => t.endsWith('return a + b;'));
    assert.ok(editor.document.getText().endsWith('return a + b;'), `document text: ${JSON.stringify(editor.document.getText())}`);
  });

  test('second run: no download, the router keeps running and local is written once', async () => {
    const out = await setUp(true);
    assert.ok(out?.ok, `setup failed: ${JSON.stringify(out)}`);
    assert.equal(downloads().length, 0, `requests: ${JSON.stringify(mock.requests.map((r) => r.path))}`);
    assert.equal(userBackends().filter((b) => b.id === BACKEND_ID).length, 1);
    assert.equal(await health(portOf(entry())), 200);
  });

  test('Stop Local Models stops the server', async () => {
    const port = portOf(entry());
    await vscode.commands.executeCommand('aiAutocomplete.stopLocalModels');
    await assert.rejects(health(port));
  });

  test('selecting the backend again starts its server without a reload; an unrelated change does not', async () => {
    const port = portOf(entry());
    const starts = join(binDir, 'starts-select');
    writeFileSync(starts, '');
    process.env[STARTS_ENV] = starts;
    try {
      // Stopped with Stop Local Models: a change that keeps the selection leaves it stopped.
      await configure({ 'completions.debounceMs': 120 });
      await sleep(1000);
      assert.equal(readFileSync(starts, 'utf8'), '', 'an unrelated settings change started the server');
      await configure({ 'completions.enabled': false });
      await configure({ 'completions.enabled': true });
      assert.ok(await healthyWithin(port, 10_000), 'the server did not start when its backend was selected again');
      assert.equal(readFileSync(starts, 'utf8').trim().split('\n').length, 1);
      // Deselecting it stops it.
      await configure({ 'completions.enabled': false });
      let down = false;
      for (const deadline = Date.now() + 10_000; !down && Date.now() < deadline; await sleep(100)) down = !(await healthy(port));
      assert.ok(down, 'the server kept running after its backend was deselected');
    } finally {
      delete process.env[STARTS_ENV];
      await unconfigure(['completions.debounceMs']);
      await configure({ 'completions.enabled': true });
    }
  });

  test('a server another window runs on the port is adopted, not started a second time', async () => {
    await vscode.commands.executeCommand('aiAutocomplete.stopLocalModels');
    const port = portOf(entry());
    const starts = join(binDir, 'starts-adopt');
    writeFileSync(starts, '');
    // The "other window": the fixture started by hand as a router on the backend's port, with the presets file.
    const other: ChildProcess = spawn(join(binDir, 'llama-server'), ['--port', String(port), '--models-preset', PRESETS], { stdio: 'ignore' });
    try {
      assert.ok(await healthyWithin(port, 10_000), 'the hand-started server did not come up');
      process.env[STARTS_ENV] = starts;
      await configure({ 'completions.enabled': false });
      await configure({ 'completions.enabled': true });
      await sleep(1500);
      assert.equal(readFileSync(starts, 'utf8'), '', 'the extension started its own server');
      assert.equal(portOf(entry()), port, 'the backend moved to another port');
      assert.ok(await healthy(port));
      // Stop Local Models does not kill it: its record has no pid (cleared by the earlier Stop), so it is not ours to stop.
      await vscode.commands.executeCommand('aiAutocomplete.stopLocalModels');
      assert.ok(await healthy(port), 'Stop Local Models stopped a server it has no record of');
    } finally {
      delete process.env[STARTS_ENV];
      other.kill('SIGTERM');
      await new Promise((r) => (other.exitCode !== null ? r(undefined) : other.once('exit', r)));
    }
  });

  test('a failed re-run on a taken port puts the backend back on its old port', async () => {
    const backends = JSON.stringify(userBackends());
    const port = portOf(entry());
    // Something that is not a llama-server holds the port: the pool takes another one and moves the backend there.
    const blocker = createServer((_req, res) => res.writeHead(404).end());
    await new Promise<void>((r) => blocker.listen(port, '127.0.0.1', r));
    const flag = join(binDir, 'exit-once-moved');
    writeFileSync(flag, '');
    process.env[EXIT_ONCE_ENV] = flag;
    try {
      // Completions off, so the failed run does not start the previous server again (which would move the backend too).
      await configure({ 'completions.enabled': false });
      const out = await setUp(true);
      assert.ok(out && !out.ok, `setup did not fail: ${JSON.stringify(out)}`);
      assert.equal(JSON.stringify(userBackends()), backends);
    } finally {
      delete process.env[EXIT_ONCE_ENV];
      blocker.closeAllConnections();
      await new Promise<void>((r) => blocker.close(() => r()));
      await configure({ 'completions.enabled': true });
    }
  });

  test('fails cleanly: a server that exits at once shows the error and writes no backend', async () => {
    const port = portOf(entry());
    await unconfigure(['backends', 'completions.backend']);
    // local is gone: its router stops.
    let down = false;
    for (const deadline = Date.now() + 10_000; !down && Date.now() < deadline; await sleep(100)) down = !(await healthy(port));
    assert.ok(down, 'the router kept running after local was removed');
    process.env[EXIT_ENV] = '1';
    try {
      const out = await setUp();
      assert.ok(out && !out.ok, `setup did not fail: ${JSON.stringify(out)}`);
      assert.match(out.message, /exited/);
      assert.match(out.message, /failed to load the model/);
      assert.equal(entry(), undefined);
    } finally {
      delete process.env[EXIT_ENV];
    }
  });

  test('the Local Models page: download, Start with the router arguments, Use for completions, a completion names the model', async () => {
    await unconfigure(['backends', 'completions.backend']);
    rmSync(join(MODELS, 'test'), { recursive: true, force: true });
    const args = join(binDir, 'args-page');
    const log = join(binDir, 'log-page');
    writeFileSync(args, '');
    writeFileSync(log, '');
    process.env[ARGS_ENV] = args;
    process.env[LOG_ENV] = log;
    try {
      await vscode.commands.executeCommand('aiAutocomplete.manageLocalModels');
      const state = (): PageState | undefined => api.localModelsPanel?.()?.lastState();
      const row = () => state()?.models.find((m) => m.name === 'test-coder');
      assert.ok(await waitFor(() => row() !== undefined, 10_000), 'the page shows no test-coder row');
      const panel = api.localModelsPanel!()!;

      await panel.handle({ type: 'download', name: 'test-coder' });
      assert.ok(await waitFor(() => row()?.download.kind === 'done', 15_000), `download state: ${JSON.stringify(row()?.download)}`);
      assert.equal(downloads().length, 1);
      assert.ok(existsSync(join(MODELS, 'test', 'test-model', 'test-model.gguf')));

      await panel.handle({ type: 'start' });
      assert.ok(await waitFor(() => state()?.server.state === 'running', 15_000), `server state: ${state()?.server.state}`);
      const [argv] = readFileSync(args, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as string[]);
      const at = (flag: string): string | undefined => argv?.[argv.indexOf(flag) + 1];
      assert.equal(at('--models-preset'), PRESETS);
      assert.equal(at('--models-max'), '1');
      assert.equal(at('--host'), '127.0.0.1');
      assert.equal(at('--port'), String(state()?.server.port));

      await panel.handle({ type: 'use', name: 'test-coder', uses: ['completions'] });
      assert.equal(vscode.workspace.getConfiguration('aiAutocomplete').get('completions.backend'), BACKEND_ID);
      assert.equal(entry()?.model, 'test-coder');
      assert.ok(await waitFor(() => (row()?.usedFor ?? []).includes('completions'), 10_000), 'the row does not show the use');

      await sleep(SETTLE_MS);
      const editor = await showAtEnd(await vscode.workspace.openTextDocument({ language: 'typescript', content: 'function add(a: number, b: number) {\n  return ' }));
      await trigger(editor);
      await commitWhen(editor, (t) => t.endsWith('return a + b;'));
      assert.ok(editor.document.getText().endsWith('return a + b;'), `document text: ${JSON.stringify(editor.document.getText())}`);
      const infill = readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as { path: string; body: string }).filter((r) => r.path === '/infill');
      assert.ok(infill.length > 0, 'the router got no /infill request');
      assert.equal((JSON.parse(infill[0]!.body) as { model?: string }).model, 'test-coder');
    } finally {
      delete process.env[ARGS_ENV];
      delete process.env[LOG_ENV];
    }
  });

  test('an old local-test backend that was selected moves to local on activation', async () => {
    await vscode.commands.executeCommand('aiAutocomplete.stopLocalModels');
    await unconfigure(['backends', 'completions.backend']);
    await configure({
      backends: [{ id: 'local-test', kind: 'llamacpp', baseUrl: 'http://127.0.0.1:59999', model: 'test-coder' }],
      'completions.backend': 'local-test',
    });
    await sleep(500);
    await local().rerunMigration([{ backendId: 'local-test', recipeId: 'test', port: 59999 }]);
    assert.equal(userBackends().find((b) => b.id === 'local-test'), undefined, 'the old entry is still there');
    assert.equal(entry()?.model, 'test-coder');
    assert.equal(vscode.workspace.getConfiguration('aiAutocomplete').inspect('completions.backend')?.globalValue, BACKEND_ID);
    await vscode.commands.executeCommand('aiAutocomplete.stopLocalModels');
  });
});
