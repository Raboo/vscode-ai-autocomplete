import * as assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { startMockServer, type MockServer } from './mockServer';

/** The part of the extension's `activate()` result these tests use. */
interface Api {
  status: { current(): string; set(state: 'idle'): void };
  secrets: { set(id: string, v: string): Promise<void>; delete(id: string): Promise<void> };
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

const useStrata = (baseUrl: string, model: string): Promise<void> =>
  configure({ backends: [{ id: BACKEND_ID, kind: 'openai', hostFlavor: 'strata', baseUrl: `${baseUrl}/v1`, fimModel: model }], 'fim.backend': BACKEND_ID });

const useLlamaCpp = (baseUrl: string, extra: Record<string, unknown> = {}): Promise<void> =>
  configure({ backends: [{ id: BACKEND_ID, kind: 'llamacpp', baseUrl }], 'fim.backend': BACKEND_ID, ...extra });

async function showAtEnd(doc: vscode.TextDocument): Promise<vscode.TextEditor> {
  const editor = await vscode.window.showTextDocument(doc);
  const end = doc.lineAt(doc.lineCount - 1).range.end;
  editor.selection = new vscode.Selection(end, end);
  return editor;
}

const openSource = async (content = SOURCE): Promise<vscode.TextEditor> => showAtEnd(await vscode.workspace.openTextDocument({ language: 'typescript', content }));

/** URIs of the documents VS Code asked for inline completions, recorded by a probe provider the suite registers. */
const asked = new Set<string>();

/**
 * Triggers inline suggestions and fails unless VS Code asked for them in `editor`. Editor commands run on the editor
 * with text focus, which need not be the active one: while the window has no OS focus, an editor focused earlier keeps it.
 */
async function trigger(editor: vscode.TextEditor): Promise<void> {
  // VS Code does not ask again for an unchanged document it already has an answer for: an edit and its undo bump the version.
  await vscode.commands.executeCommand('editor.action.inlineSuggest.hide');
  const end = editor.selection.active;
  await editor.edit((b) => b.insert(end, ' '));
  await editor.edit((b) => b.delete(new vscode.Range(end, end.translate(0, 1))));
  asked.delete(editor.document.uri.toString());
  await vscode.commands.executeCommand('editor.action.inlineSuggest.trigger');
  const uri = editor.document.uri.toString();
  assert.ok(await waitFor(() => asked.has(uri), 2000), `the trigger did not reach ${uri}; VS Code asked for ${JSON.stringify([...asked])}`);
}
const commit = (): Thenable<unknown> => vscode.commands.executeCommand('editor.action.inlineSuggest.commit');

/** Commits the ghost text every 50 ms until `cond` holds for the document text or 5 s pass (a commit with no ghost text does nothing). */
async function commitWhen(editor: vscode.TextEditor, cond: (text: string) => boolean): Promise<void> {
  await waitFor(() => {
    void commit();
    return cond(editor.document.getText());
  }, 5000);
}

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
    await commitWhen(editor, (t) => t.endsWith('return a + b;'));

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

  const posts = (m: MockServer, path: string) => m.requests.filter((r) => r.method === 'POST' && r.path === path);
  const withMock = async (opts: Parameters<typeof startMockServer>[0], fn: (m: MockServer) => Promise<void>): Promise<void> => {
    const m = await startMockServer(opts);
    try {
      await fn(m);
    } finally {
      await m.close();
    }
  };

  test('ghost text from a chat model on Strata, thinking off', async () => {
    // Qwen3 templates prefill an empty think block with thinking off, and some servers stream it as content.
    await withMock({ alias: 'qwen3.8-flash-next-iq3_s', chat: { content: ['<think>\n\n</think>\n\n<COMPLETION>a + b;'] } }, async (m) => {
      await useStrata(m.baseUrl, 'qwen3.8-flash-next-iq3_s');
      const editor = await openSource(`${'// a comment line\n'.repeat(8)}${SOURCE}`);  // long enough for a pin: it stops 4 lines above the cursor

      await trigger(editor);
      assert.ok(await waitFor(() => posts(m, '/v1/chat/completions').length >= 1, 5000), `mock saw ${JSON.stringify(m.requests)}`);
      await commitWhen(editor, (t) => t.endsWith('return a + b;'));

      const text = editor.document.getText();
      assert.ok(text.endsWith('return a + b;'), `document text: ${JSON.stringify(text)}`);
      const body = posts(m, '/v1/chat/completions')[0].body as Record<string, unknown>;
      assert.equal(body.stream, true);
      assert.equal(body.presence_penalty, 0);
      assert.equal(body.reasoning_effort, 'none');
      assert.deepEqual(body.chat_template_kwargs, { enable_thinking: false });
      assert.deepEqual(body.stop, ['</COMPLETION>']);
      const pin = body.strata_prefix as { message: number; chars: number };
      assert.equal(pin.message, 1);
      assert.ok(pin.chars > 0, JSON.stringify(pin));
      const messages = body.messages as { role: string; content: string }[];
      assert.equal(messages[0].role, 'system');
      assert.ok(messages[1].content.includes('<|cursor|>'), JSON.stringify(messages[1]));
      assert.equal(posts(m, '/v1/completions').length + posts(m, '/infill').length, 0, `mock saw ${JSON.stringify(m.requests)}`);
      assert.ok(!api.status.current().includes('keeps thinking'), `status: ${api.status.current()}`);
    });
  });

  test('a model that keeps thinking fails, and Retry now asks again', async () => {
    await withMock({ alias: 'qwen3.8-flash-next-iq3_s', chat: { reasoning: ['Let me think.'] } }, async (m) => {
      await useStrata(m.baseUrl, 'qwen3.8-flash-next-iq3_s');
      const editor = await openSource();

      await trigger(editor);
      assert.ok(await waitFor(() => api.status.current().includes('keeps thinking'), 5000), `status: ${api.status.current()}`);
      assert.equal(posts(m, '/v1/chat/completions').length, 1, `mock saw ${JSON.stringify(m.requests)}`);
      // Ghost text only reaches the document on commit, so commit before checking that none was shown.
      await commit();
      assert.equal(editor.document.getText(), SOURCE);

      // The model is blocked: no request goes out.
      await trigger(editor);
      await sleep(500);
      assert.equal(posts(m, '/v1/chat/completions').length, 1, `mock saw ${JSON.stringify(m.requests)}`);
      assert.ok(api.status.current().includes('keeps thinking'), `status: ${api.status.current()}`);

      await vscode.commands.executeCommand('aiAutocomplete.retry');
      await trigger(editor);
      assert.ok(await waitFor(() => posts(m, '/v1/chat/completions').length >= 2, 5000), `mock saw ${JSON.stringify(m.requests)}`);
    });
  });

  test('a model that cannot turn thinking off sends nothing', async () => {
    await withMock({ alias: 'gpt-oss-20b' }, async (m) => {
      await useStrata(m.baseUrl, 'gpt-oss-20b');
      const editor = await openSource();

      await trigger(editor);
      assert.ok(await waitFor(() => api.status.current().includes('cannot turn thinking off'), 5000), `status: ${api.status.current()}`);
      await sleep(300);
      assert.equal(posts(m, '/v1/chat/completions').length, 0, `mock saw ${JSON.stringify(m.requests)}`);
    });
  });

  test('an OpenRouter model that rejects effort "none" and then reasons cannot turn thinking off', async () => {
    await withMock({ alias: 'google/gemini-2.5-pro', rejectField: 'reasoning', chat: { reasoning: ['Let me think.'] } }, async (m) => {
      await api.secrets.set(BACKEND_ID, 'test-key'); // OpenRouter sends no code without a key
      try {
        await configure({ backends: [{ id: BACKEND_ID, kind: 'openai', hostFlavor: 'openrouter', baseUrl: `${m.baseUrl}/v1`, fimModel: 'google/gemini-2.5-pro' }], 'fim.backend': BACKEND_ID });
        const editor = await openSource();

        // The first trigger already says so: the server rejected turning reasoning off, so no other switch can help.
        await trigger(editor);
        assert.ok(await waitFor(() => api.status.current().includes('cannot turn thinking off'), 5000), `status: ${api.status.current()}`);
        const chats = posts(m, '/v1/chat/completions');
        assert.equal(chats.length, 2, `mock saw ${JSON.stringify(m.requests)}`);
        assert.ok('reasoning' in (chats[0].body ?? {}));
        assert.ok(!('reasoning' in (chats[1].body ?? {})), JSON.stringify(chats[1].body));

        // The model is blocked: no request goes out.
        await trigger(editor);
        await sleep(500);
        assert.equal(posts(m, '/v1/chat/completions').length, 2, `mock saw ${JSON.stringify(m.requests)}`);
        assert.ok(api.status.current().includes('cannot turn thinking off'), `status: ${api.status.current()}`);
      } finally {
        await api.secrets.delete(BACKEND_ID);
      }
    });
  });

  test('OpenRouter without a model sends nothing', async () => {
    await configure({ backends: [{ id: BACKEND_ID, kind: 'openai', hostFlavor: 'openrouter', baseUrl: `${mock.baseUrl}/v1` }], 'fim.backend': BACKEND_ID });
    const editor = await openSource();

    await trigger(editor);
    assert.ok(await waitFor(() => api.status.current().includes('choose a model'), 5000), `status: ${api.status.current()}`);
    assert.equal(mock.requests.filter((r) => r.method === 'POST').length, 0, `mock saw ${JSON.stringify(mock.requests)}`);
  });

  /** A llama.cpp backend whose /infill answers 501, so the template route (/completion) is the fallback. */
  const learnMissingInfill = async (m: MockServer, editor: vscode.TextEditor): Promise<void> => {
    await trigger(editor);
    assert.ok(await waitFor(() => posts(m, '/infill').length >= 1, 5000), `mock saw ${JSON.stringify(m.requests)}`);
    // The request ends without an error: a missing route is learned, not a failure.
    await sleep(500);
    assert.ok(!api.status.current().includes('error'), `status: ${api.status.current()}`);
    // Ghost text only reaches the document on commit, so commit before checking that none was shown.
    await commit();
    assert.equal(editor.document.getText(), SOURCE);
    assert.equal(posts(m, '/completion').length, 0, `mock saw ${JSON.stringify(m.requests)}`);
  };

  test('a missing route is learned silently and the next trigger uses the next route', async () => {
    await withMock({ infill501: true }, async (m) => {
      await useLlamaCpp(m.baseUrl);
      const editor = await openSource();
      await learnMissingInfill(m, editor);

      await trigger(editor);
      assert.ok(await waitFor(() => posts(m, '/completion').length >= 1, 5000), `mock saw ${JSON.stringify(m.requests)}`);
      await commitWhen(editor, (t) => t.endsWith('a + b;'));

      assert.ok(editor.document.getText().endsWith('a + b;'), `document text: ${JSON.stringify(editor.document.getText())}`);
      assert.equal(posts(m, '/infill').length, 1, `mock saw ${JSON.stringify(m.requests)}`);
    });
  });

  test('Retry now forgets a learned missing route', async () => {
    await withMock({ infill501: true }, async (m) => {
      await useLlamaCpp(m.baseUrl);
      const editor = await openSource();
      await learnMissingInfill(m, editor);
      await trigger(editor);
      assert.ok(await waitFor(() => posts(m, '/completion').length >= 1, 5000), `mock saw ${JSON.stringify(m.requests)}`);
      await sleep(500);

      await vscode.commands.executeCommand('aiAutocomplete.retry');
      await trigger(editor);

      assert.ok(await waitFor(() => posts(m, '/infill').length >= 2, 5000), `mock saw ${JSON.stringify(m.requests)}`);
    });
  });

  test('a 404 that mentions a model is an ordinary error, not a learned route', async () => {
    await withMock({ infill404Body: JSON.stringify({ error: 'model "x" not found' }) }, async (m) => {
      await useLlamaCpp(m.baseUrl);
      const editor = await openSource();

      await trigger(editor);
      assert.ok(await waitFor(() => api.status.current().includes('error'), 5000), `status: ${api.status.current()}`);
      assert.equal(posts(m, '/completion').length, 0);

      // The backend backs off for 2 s; after that the same route is tried again.
      await sleep(2500);
      await trigger(editor);
      assert.ok(await waitFor(() => posts(m, '/infill').length >= 2, 5000), `mock saw ${JSON.stringify(m.requests)}`);
      assert.equal(posts(m, '/completion').length, 0, `mock saw ${JSON.stringify(m.requests)}`);
    });
  });

  test('a missing route without a fallback is an ordinary error with backoff', async () => {
    await withMock({ infill501: true }, async (m) => {
      await configure({ backends: [{ id: BACKEND_ID, kind: 'llamacpp', baseUrl: m.baseUrl, fimMode: 'native' }], 'fim.backend': BACKEND_ID });
      const editor = await openSource();

      await trigger(editor);
      assert.ok(await waitFor(() => api.status.current().includes('error'), 5000), `status: ${api.status.current()}`);

      // Inside the backoff nothing is sent, and no other route is tried.
      await trigger(editor);
      await sleep(500);
      assert.equal(posts(m, '/infill').length, 1, `mock saw ${JSON.stringify(m.requests)}`);
      assert.equal(posts(m, '/completion').length, 0, `mock saw ${JSON.stringify(m.requests)}`);
    });
  });

  test('a server-rejected thinking field is retried once and left out afterwards', async () => {
    await withMock({ alias: 'qwen3.8-flash-next-iq3_s', rejectField: 'chat_template_kwargs' }, async (m) => {
      await useStrata(m.baseUrl, 'qwen3.8-flash-next-iq3_s');
      const editor = await openSource();

      await trigger(editor);
      assert.ok(await waitFor(() => posts(m, '/v1/chat/completions').length >= 2, 5000), `mock saw ${JSON.stringify(m.requests)}`);
      await commitWhen(editor, (t) => t.endsWith('return a + b;'));
      const first = posts(m, '/v1/chat/completions');
      assert.equal(first.length, 2);
      assert.ok('chat_template_kwargs' in (first[0].body ?? {}));
      assert.ok(!('chat_template_kwargs' in (first[1].body ?? {})), JSON.stringify(first[1].body));
      assert.ok(editor.document.getText().endsWith('return a + b;'));

      m.reset();
      await trigger(editor);
      assert.ok(await waitFor(() => posts(m, '/v1/chat/completions').length >= 1, 5000), `mock saw ${JSON.stringify(m.requests)}`);
      await sleep(500);
      const second = posts(m, '/v1/chat/completions');
      assert.equal(second.length, 1, `mock saw ${JSON.stringify(m.requests)}`);
      assert.ok(!('chat_template_kwargs' in (second[0].body ?? {})), JSON.stringify(second[0].body));
    });
  });
});
