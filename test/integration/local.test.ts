import * as assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as vscode from 'vscode';
import type { Recipe } from '../../src/local/recipes';
import type { SetupOutcome } from '../../src/local/vscode/setup';
import { clearAsked, commitWhen, configure, registerProbe, showAtEnd, sleep, SETTLE_MS, trigger, unconfigure } from './helpers';
import { startMockServer, type MockServer } from './mockServer';

/** The part of the extension's `activate()` result these tests use. */
interface Api {
  local?: { setRecipes(r: Recipe[] | undefined): void };
}

const ROOT = join(__dirname, '..', '..', '..');
const FIXTURE = join(ROOT, 'test', 'integration', 'fixtures', 'fake-llama-server.mjs');
/** `.vscode-test.mjs` pins the user data folder; the extension's global storage is in it. */
const MODELS = join(ROOT, '.vscode-test', 'user-data', 'User', 'globalStorage', 'raboo.ai-autocomplete', 'models');
const FILE_PATH = '/files/test-model.gguf';
const BYTES = Buffer.from(Array.from({ length: 64 * 1024 }, (_, i) => (i * 31 + 7) % 256));
const BACKEND_ID = 'local-test';
const EXIT_ENV = 'FAKE_LLAMA_SERVER_EXIT';
const EXIT_ONCE_ENV = 'FAKE_LLAMA_SERVER_EXIT_ONCE';
/** Every setting a test may write; teardown resets them. */
const TOUCHED = ['backends', 'fim.backend', 'fim.enabled', 'nextEdit.backend', 'nextEdit.enabled', 'local.llamaServerPath'];

const userBackends = (): Record<string, unknown>[] => {
  const list = vscode.workspace.getConfiguration('aiAutocomplete').inspect('backends')?.globalValue;
  return Array.isArray(list) ? (list as Record<string, unknown>[]) : [];
};
const entry = (): Record<string, unknown> | undefined => userBackends().find((e) => e.id === BACKEND_ID);
const portOf = (e: Record<string, unknown> | undefined): number => Number(new URL(String(e?.baseUrl)).port);
const setUp = (replace = false): Thenable<SetupOutcome> =>
  vscode.commands.executeCommand<SetupOutcome>('aiAutocomplete.setUpLocalModel', { recipe: 'test', runtime: 'llamaServer', ...(replace ? { replace } : {}) });
const health = async (port: number): Promise<number> => (await fetch(`http://127.0.0.1:${port}/health`)).status;
const healthy = async (port: number): Promise<boolean> => (await health(port).catch(() => 0)) === 200;

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

  test('setup downloads the model, starts llama-server, writes and selects the backend, and completions work', async () => {
    const out = await setUp();
    assert.ok(out?.ok, `setup failed: ${JSON.stringify(out)}`);
    assert.equal(out.backendId, BACKEND_ID);
    assert.equal(out.steps.find((s) => s.state === 'fail'), undefined, `test steps: ${JSON.stringify(out.steps)}`);
    assert.equal(downloads().length, 1, `requests: ${JSON.stringify(mock.requests.map((r) => r.path))}`);
    assert.ok(existsSync(join(MODELS, 'test', 'test-model', 'test-model.gguf')), 'the model file is not in global storage');

    const e = entry();
    assert.equal(e?.kind, 'llamacpp');
    assert.equal(e?.fimModel, 'test-coder');
    assert.match(String(e?.baseUrl), /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.equal(vscode.workspace.getConfiguration('aiAutocomplete').get('fim.backend'), BACKEND_ID);
    assert.equal(await health(portOf(e)), 200);

    await sleep(SETTLE_MS);
    const editor = await showAtEnd(await vscode.workspace.openTextDocument({ language: 'typescript', content: 'function add(a: number, b: number) {\n  return ' }));
    await trigger(editor);
    await commitWhen(editor, (t) => t.endsWith('return a + b;'));
    assert.ok(editor.document.getText().endsWith('return a + b;'), `document text: ${JSON.stringify(editor.document.getText())}`);
  });

  test('second run: no download, the server starts again and the backend is replaced', async () => {
    const out = await setUp(true);
    assert.ok(out?.ok, `setup failed: ${JSON.stringify(out)}`);
    assert.equal(downloads().length, 0, `requests: ${JSON.stringify(mock.requests.map((r) => r.path))}`);
    assert.equal(userBackends().filter((b) => b.id === BACKEND_ID).length, 1);
    assert.equal(await health(portOf(entry())), 200);
  });

  test('a failed re-run keeps the backend and its selection, and starts the previous server again', async () => {
    const backends = JSON.stringify(userBackends());
    const flag = join(binDir, 'exit-once');
    writeFileSync(flag, '');
    process.env[EXIT_ONCE_ENV] = flag;
    try {
      const out = await setUp(true);
      assert.ok(out && !out.ok, `setup did not fail: ${JSON.stringify(out)}`);
      assert.equal(JSON.stringify(userBackends()), backends);
      assert.equal(vscode.workspace.getConfiguration('aiAutocomplete').get('fim.backend'), BACKEND_ID);
      // The restart runs the fixture again, which works now that the flag file is gone.
      let up = false;
      for (const deadline = Date.now() + 10_000; !up && Date.now() < deadline; await sleep(100)) up = await healthy(portOf(entry()));
      assert.ok(up, `the previous server did not come back (backend ${JSON.stringify(entry())})`);
    } finally {
      delete process.env[EXIT_ONCE_ENV];
    }
  });

  test('Stop Local Models stops the server', async () => {
    const port = portOf(entry());
    await vscode.commands.executeCommand('aiAutocomplete.stopLocalModels');
    await assert.rejects(health(port));
  });

  test('fails cleanly: a server that exits at once shows the error and writes no backend', async () => {
    await unconfigure(['backends', 'fim.backend']);
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
});
