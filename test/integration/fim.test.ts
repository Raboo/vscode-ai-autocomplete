import * as assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { startMockServer, type MockServer } from './mockServer';

/** The part of the extension's `activate()` result these tests use. */
interface Api {
  status: { current(): string; set(state: 'idle'): void };
}

const SOURCE = 'function add(a: number, b: number) {\n  return ';
const BACKEND_ID = 'test';
/** Every setting a test may write; teardown resets them so tests stay independent. */
const TOUCHED = ['backends', 'fim.backend', 'fim.disableInLanguages', 'privacy.localOnly'];
/** Time for the extension's onDidChangeConfiguration handler to rebuild its backends. */
const SETTLE_MS = 200;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Polls `cond` every 50 ms; resolves whether it became true within `timeoutMs`. */
async function waitFor(cond: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) return false;
    await sleep(50);
  }
  return true;
}

async function configure(values: Record<string, unknown>): Promise<void> {
  const cfg = vscode.workspace.getConfiguration('aiAutocomplete');
  for (const [key, value] of Object.entries(values)) await cfg.update(key, value, vscode.ConfigurationTarget.Global);
  await sleep(SETTLE_MS);
}

const useLlamaCpp = (baseUrl: string, extra: Record<string, unknown> = {}): Promise<void> =>
  configure({ backends: [{ id: BACKEND_ID, kind: 'llamacpp', baseUrl }], 'fim.backend': BACKEND_ID, ...extra });

async function showAtEnd(doc: vscode.TextDocument): Promise<vscode.TextEditor> {
  const editor = await vscode.window.showTextDocument(doc);
  const end = doc.lineAt(doc.lineCount - 1).range.end;
  editor.selection = new vscode.Selection(end, end);
  return editor;
}

const openSource = async (): Promise<vscode.TextEditor> => showAtEnd(await vscode.workspace.openTextDocument({ language: 'typescript', content: SOURCE }));

/** URIs of the documents VS Code asked for inline completions, recorded by a probe provider the suite registers. */
const asked = new Set<string>();

/**
 * Triggers inline suggestions and fails unless VS Code asked for them in `editor`. Editor commands run on the editor
 * with text focus, which need not be the active one: while the window has no OS focus, an editor focused earlier keeps it.
 */
async function trigger(editor: vscode.TextEditor): Promise<void> {
  await vscode.commands.executeCommand('editor.action.inlineSuggest.trigger');
  const uri = editor.document.uri.toString();
  assert.ok(await waitFor(() => asked.has(uri), 2000), `the trigger did not reach ${uri}; VS Code asked for ${JSON.stringify([...asked])}`);
}
const commit = (): Thenable<unknown> => vscode.commands.executeCommand('editor.action.inlineSuggest.commit');

suite('FIM inline completion', () => {
  let mock: MockServer;
  let api: Api;
  let tempDir: string | undefined;
  let probe: vscode.Disposable;

  const infillRequests = () => mock.requests.filter((r) => r.path === '/infill');

  suiteSetup(async () => {
    mock = await startMockServer();
    const ext = vscode.extensions.getExtension<Api>('raboo.ai-autocomplete')!;
    api = await ext.activate();
    // Registered once: adding or removing a provider while a request runs could disturb the extension's request.
    probe = vscode.languages.registerInlineCompletionItemProvider({ pattern: '**' }, {
      provideInlineCompletionItems: (doc) => {
        asked.add(doc.uri.toString());
        return [];
      },
    });
  });

  suiteTeardown(async () => {
    probe.dispose();
    await mock.close();
  });

  setup(() => {
    mock.reset();
    asked.clear();
    // The status bar keeps its last state; start each test from idle so an error must come from this test.
    api.status.set('idle');
  });

  teardown(async () => {
    await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
    const cfg = vscode.workspace.getConfiguration('aiAutocomplete');
    for (const key of TOUCHED) await cfg.update(key, undefined, vscode.ConfigurationTarget.Global);
    await sleep(SETTLE_MS);
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  });

  test('ghost text from llama.cpp /infill', async () => {
    await useLlamaCpp(mock.baseUrl);
    const editor = await openSource();

    await trigger(editor);
    assert.ok(await waitFor(() => infillRequests().length >= 1, 5000), `no /infill request; mock saw ${JSON.stringify(mock.requests)}`);
    await sleep(300);
    await commit();

    const text = editor.document.getText();
    assert.ok(text.endsWith('return a + b;'), `document text: ${JSON.stringify(text)}`);
    const prefix = infillRequests()[0].body?.input_prefix;
    assert.equal(typeof prefix, 'string');
    assert.ok((prefix as string).endsWith('return '), `input_prefix: ${JSON.stringify(prefix)}`);
  });

  test('localOnly blocks a non-local backend', async () => {
    await useLlamaCpp('https://example.com', { 'privacy.localOnly': true });
    const editor = await openSource();

    await trigger(editor);
    await sleep(1000);

    assert.equal(mock.requests.length, 0);
    const status = api.status.current();
    assert.ok(status.includes('error'), `status: ${status}`);
    assert.ok(status.includes('not local'), `status: ${status}`);
  });

  test('unreachable backend → error status, no item', async () => {
    await useLlamaCpp('http://127.0.0.1:9');
    const editor = await openSource();

    await trigger(editor);
    // Model detection and the /infill request both fail; allow for timeouts if the port does not refuse at once.
    await waitFor(() => api.status.current().includes('error'), 8000);

    const status = api.status.current();
    assert.ok(status.includes('error'), `status: ${status}`);
    assert.ok(status.includes('cannot reach backend'), `status: ${status}`);
    await commit();
    assert.equal(editor.document.getText(), SOURCE);
  });

  test('excluded file gets no request', async () => {
    // No language is disabled, so only the `**/.env` entry of fim.disableInFiles can stop the request.
    await useLlamaCpp(mock.baseUrl, { 'fim.disableInLanguages': [] });
    tempDir = mkdtempSync(join(tmpdir(), 'ai-autocomplete-'));
    const file = join(tempDir, '.env');
    writeFileSync(file, 'API_KEY=');
    const editor = await showAtEnd(await vscode.workspace.openTextDocument(vscode.Uri.file(file)));

    await trigger(editor);
    await sleep(1000);

    assert.equal(mock.requests.length, 0, `mock saw ${JSON.stringify(mock.requests)}`);
  });

  test('a model without template shows "no completion template" and sends no completion request', async () => {
    const lm = await startMockServer({ alias: 'zeta-2.1' });
    try {
      await configure({
        backends: [{ id: BACKEND_ID, kind: 'openai', hostFlavor: 'lmstudio', baseUrl: `${lm.baseUrl}/v1` }],
        'fim.backend': BACKEND_ID,
      });
      const editor = await openSource();

      await trigger(editor);
      assert.ok(await waitFor(() => api.status.current().includes('no completion template'), 5000), `status: ${api.status.current()}`);
      const completions = lm.requests.filter((r) => r.method === 'POST' && (r.path === '/v1/completions' || r.path === '/infill'));
      assert.equal(completions.length, 0, `mock saw ${JSON.stringify(lm.requests)}`);
    } finally {
      await lm.close();
    }
  });

  test('choosing a template in the settings clears "no completion template" without a new request', async () => {
    const lm = await startMockServer({ alias: 'zeta-2.1' });
    try {
      const entry = { id: BACKEND_ID, kind: 'openai', hostFlavor: 'lmstudio', baseUrl: `${lm.baseUrl}/v1` };
      await configure({ backends: [entry], 'fim.backend': BACKEND_ID });
      const editor = await openSource();
      await trigger(editor);
      assert.ok(await waitFor(() => api.status.current().includes('no completion template'), 5000), `status: ${api.status.current()}`);

      // What Save on the Backends page writes for the Zeta fix.
      await configure({ backends: [{ ...entry, fim: { template: 'seed-coder' } }] });

      assert.ok(await waitFor(() => api.status.current() === 'idle', 2000), `status: ${api.status.current()}`);
      const posts = lm.requests.filter((r) => r.method === 'POST');
      assert.equal(posts.length, 0, `mock saw ${JSON.stringify(lm.requests)}`);
    } finally {
      await lm.close();
    }
  });
});
