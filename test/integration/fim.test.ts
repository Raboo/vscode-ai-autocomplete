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
const trigger = (): Thenable<unknown> => vscode.commands.executeCommand('editor.action.inlineSuggest.trigger');
const commit = (): Thenable<unknown> => vscode.commands.executeCommand('editor.action.inlineSuggest.commit');

suite('FIM inline completion', () => {
  let mock: MockServer;
  let api: Api;
  let tempDir: string | undefined;

  const infillRequests = () => mock.requests.filter((r) => r.path === '/infill');

  suiteSetup(async () => {
    mock = await startMockServer();
    const ext = vscode.extensions.getExtension<Api>('raboo.ai-autocomplete')!;
    api = await ext.activate();
  });

  suiteTeardown(async () => {
    await mock.close();
  });

  setup(() => {
    mock.reset();
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

    await trigger();
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
    await openSource();

    await trigger();
    await sleep(1000);

    assert.equal(mock.requests.length, 0);
    const status = api.status.current();
    assert.ok(status.includes('error'), `status: ${status}`);
    assert.ok(status.includes('not local'), `status: ${status}`);
  });

  test('unreachable backend → error status, no item', async () => {
    await useLlamaCpp('http://127.0.0.1:9');
    const editor = await openSource();

    await trigger();
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
    await showAtEnd(await vscode.workspace.openTextDocument(vscode.Uri.file(file)));

    await trigger();
    await sleep(1000);

    assert.equal(mock.requests.length, 0, `mock saw ${JSON.stringify(mock.requests)}`);
  });
});
