import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import type { BackendForm, PageMessage, PageState } from '../../src/manage/protocol';
import { startMockServer, type MockServer } from './mockServer';

/** The part of the extension's `activate()` result these tests use. */
interface Panel {
  handle(msg: PageMessage): Promise<void>;
  lastState(): PageState | undefined;
  dispose(): void;
}
interface Api {
  secrets: { get(id: string): Promise<string | undefined>; set(id: string, v: string): Promise<void>; delete(id: string): Promise<void> };
  backendsPanel(): Panel | undefined;
}

/** Every setting a test may write; teardown resets them so tests stay independent. */
const TOUCHED = ['backends', 'fim.backend', 'privacy.localOnly'];
/** Every API key a test may store. */
const KEYS = ['old', 'renamed'];
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

const userBackends = (): unknown => vscode.workspace.getConfiguration('aiAutocomplete').inspect('backends')?.globalValue;
const backendTabs = (): vscode.Tab[] =>
  vscode.window.tabGroups.all.flatMap((g) => g.tabs).filter((t) => t.input instanceof vscode.TabInputWebview && t.input.viewType.includes('aiAutocomplete.backends'));

suite('Backends page', () => {
  let mock: MockServer;
  let api: Api;

  const open = async (): Promise<Panel> => {
    await vscode.commands.executeCommand('aiAutocomplete.manageBackends');
    const panel = api.backendsPanel();
    assert.ok(panel, 'no panel after the command');
    return panel;
  };
  /** Opens a new draft and replaces its form, as the page does on each change. */
  const draft = async (panel: Panel, over: Partial<BackendForm>): Promise<BackendForm> => {
    await panel.handle({ type: 'add' });
    const form = { ...panel.lastState()!.edit!.form, ...over };
    await panel.handle({ type: 'formChanged', form });
    return form;
  };

  suiteSetup(async () => {
    mock = await startMockServer({ nCtx: 8192 });
    const ext = vscode.extensions.getExtension<Api>('raboo.ai-autocomplete')!;
    api = await ext.activate();
  });

  suiteTeardown(async () => {
    await mock.close();
  });

  setup(() => mock.reset());

  teardown(async () => {
    api.backendsPanel()?.dispose();
    const cfg = vscode.workspace.getConfiguration('aiAutocomplete');
    for (const key of TOUCHED) await cfg.update(key, undefined, vscode.ConfigurationTarget.Global);
    for (const id of KEYS) await api.secrets.delete(id);
    await sleep(SETTLE_MS);
  });

  test('the command opens one panel; a second call reveals the same one', async () => {
    const first = await open();
    // The page posts `ready` once its script runs under the CSP; the host answers with the first state.
    assert.ok(await waitFor(() => first.lastState() !== undefined, 10_000), 'the page never asked for its state');
    assert.equal(first.lastState()!.cards.length, 0);
    const second = await open();
    assert.equal(second, first);
    assert.equal(backendTabs().length, 1);

    await vscode.commands.executeCommand('aiAutocomplete.manageBackends', { add: true });
    assert.ok(await waitFor(() => first.lastState()?.edit?.cardId === null, 5000), 'add did not open a new draft');
    assert.equal(api.backendsPanel(), first);
    assert.equal(backendTabs().length, 1);
  });

  test('save writes the entry to user settings and keeps other entries', async () => {
    const keep = { id: 'keep', kind: 'openai', hostFlavor: 'vllm', baseUrl: 'http://127.0.0.1:8000/v1', custom: { x: 1 } };
    await configure({ backends: [keep] });
    const panel = await open();
    const form = await draft(panel, { id: 'fresh', baseUrl: mock.baseUrl, changed: { temperature: '0.2' } });

    await panel.handle({ type: 'save', form });

    assert.deepEqual(userBackends(), [keep, { id: 'fresh', kind: 'llamacpp', baseUrl: mock.baseUrl, fim: { temperature: 0.2 } }]);
    assert.equal(panel.lastState()!.edit, undefined, 'the draft stays open after save');
    assert.equal(vscode.workspace.getConfiguration('aiAutocomplete').inspect('backends')?.workspaceValue, undefined);
  });

  test('testForm against the mock server ends with reach, model, completion and context ok', async () => {
    const panel = await open();
    const form = await draft(panel, { baseUrl: mock.baseUrl });

    await panel.handle({ type: 'testForm', form });
    assert.ok(await waitFor(() => panel.lastState()?.edit?.testing === false, 15_000), 'the test did not finish');

    const steps = panel.lastState()!.edit!.test ?? [];
    assert.deepEqual(steps.map((s) => `${s.id}:${s.state}`), ['reach:ok', 'model:ok', 'completion:ok', 'context:ok'], JSON.stringify(steps));
    assert.ok(mock.requests.some((r) => r.path === '/infill'), `mock saw ${JSON.stringify(mock.requests)}`);
  });

  test('reloadModels under localOnly makes no request', async () => {
    await configure({ 'privacy.localOnly': true });
    const panel = await open();
    const form = await draft(panel, { type: 'other', id: 'hosted', baseUrl: 'https://example.invalid/v1' });

    await panel.handle({ type: 'reloadModels', form, apiKey: 'sk-test' });
    assert.ok(await waitFor(() => panel.lastState()?.edit?.modelsError !== undefined, 10_000), 'no modelsError');

    assert.equal(panel.lastState()!.edit!.modelsError, 'local only is on in this workspace');
    assert.equal(panel.lastState()!.edit!.models, undefined);
    assert.deepEqual(mock.requests, []);
  });

  test('rename moves the stored key', async () => {
    await configure({ backends: [{ id: 'old', kind: 'llamacpp', baseUrl: mock.baseUrl }], 'fim.backend': 'old' });
    await api.secrets.set('old', 'sk-moved');
    const panel = await open();
    await panel.handle({ type: 'edit', id: 'old' });
    const form = panel.lastState()!.edit!.form;
    assert.equal(form.originalId, 'old');

    await panel.handle({ type: 'save', form: { ...form, id: 'renamed' } });

    assert.equal(await api.secrets.get('renamed'), 'sk-moved');
    assert.equal(await api.secrets.get('old'), undefined);
    assert.deepEqual(userBackends(), [{ id: 'renamed', kind: 'llamacpp', baseUrl: mock.baseUrl }]);
    assert.equal(vscode.workspace.getConfiguration('aiAutocomplete').inspect('fim.backend')?.globalValue, 'renamed');
    assert.ok(!JSON.stringify(panel.lastState()).includes('sk-moved'), 'the key reached the page');
  });
});
