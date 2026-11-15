import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { commit, commitWhen, configure, registerProbe, showAtEnd, sleep, trigger, unconfigure, waitFor } from './helpers';
import { NEXT_EDIT_TAG, startMockServer, userMessage, type MockOptions, type MockServer, type RecordedRequest } from './mockServer';

/** The part of the extension's `activate()` result these tests use. */
interface Api {
  nativeNextEdit: boolean;
}

type Launch = 'main' | 'proposed';
/** The `.vscode-test.mjs` launch running this file: `main` is Stable as users get it, `proposed` enables the inline-edit proposal. */
const LAUNCH = process.env.AI_AUTOCOMPLETE_TEST_LAUNCH;

/** A test for one launch only; it shows as pending in the other. */
function testIn(launch: Launch, title: string, fn: () => Promise<void>): void {
  test(title, async function () {
    if (LAUNCH !== launch) this.skip();
    await fn();
  });
}

const BACKEND_ID = 'test';
const MODEL = 'qwen3.8-flash-next-iq3_s';
/** Every setting a test may write; teardown resets them so tests stay independent. */
const TOUCHED = ['backends', 'fim.backend', 'fim.enabled', 'fim.extraContext', 'fim.disableInLanguages', 'nextEdit.backend'];
/** FIM's answer in these tests: nothing to insert, so FIM lets Next Edit ask after the edit pause. */
const EMPTY_FIM = { content: ['<COMPLETION></COMPLETION>'] };
/** Covers the edit pause (400 ms), FIM's request and Next Edit's own against the local mock. */
const REQUEST_WAIT_MS = 5000;
/** How long a negative check waits for a request that must not come: well past the 400 ms edit pause. */
const NO_REQUEST_WAIT_MS = 1500;
/** The mock answers at once; this covers the extension reading the answer after the mock saw the request. */
const ANSWERED_MS = 300;
/** Edits further apart than this are separate history entries (HISTORY_IDLE_MS is 1500). */
const HISTORY_IDLE_WAIT_MS = 1700;
/** The mock's delay for an answer that arrives after a newer edit. */
const SLOW_ANSWER_MS = 1500;

const GREET = ['def greet(name):', '    message = "Hello, " + nam'];
/** GREET after typing `e`, and the line Next Edit adds below the cursor. */
const GREETED = ['def greet(name):', '    message = "Hello, " + name'];
const RETURN_LINE = '    return message';

/** The live probe's module: `r` was renamed to `radius` in circle_area (the cursor's line 4), not yet in the functions below. */
const CIRCLE = [
  'import math', '', '', 'def circle_area(radius):', '    return math.pi * radius ** 2', '', '',
  'def circle_circumference(r):', '    return 2 * math.pi * r', '', '', 'def circle_diameter(r):', '    return 2 * r',
];
/** CIRCLE before the rename's last step: line 4 still uses `r`. */
const BEFORE_RENAME = CIRCLE.map((l, i) => (i === 4 ? '    return math.pi * r ** 2' : l));
/** What the model makes of CIRCLE: the rename carried into circle_circumference (lines 7 and 8). */
const RENAMED = CIRCLE.map((l, i) => (i === 7 ? 'def circle_circumference(radius):' : i === 8 ? '    return 2 * math.pi * radius' : l));

/** A chatXtab answer: the rewritten region in one fenced block. The documents here are short, so the region is the whole file. */
const fence = (lines: string[]): string[] => ['```\n', `${lines.join('\n')}\n`, '```\n'];

const isChat = (r: RecordedRequest): boolean => r.method === 'POST' && r.path === '/v1/chat/completions';
const isNextEdit = (r: RecordedRequest): boolean => isChat(r) && userMessage(r.body).includes(NEXT_EDIT_TAG);
const nextEdits = (m: MockServer) => m.requests.filter(isNextEdit);
/** FIM wins: Next Edit was first asked after FIM's request (a chat request without `<|code_to_edit|>`). */
const askedAfterFim = (m: MockServer): boolean => {
  const fim = m.requests.findIndex((r) => isChat(r) && !isNextEdit(r));
  return fim >= 0 && fim < m.requests.findIndex(isNextEdit);
};
/** The path the extension writes into prompts and diffs for a document. */
const pathOf = (doc: vscode.TextDocument): string => vscode.workspace.asRelativePath(doc.uri, false);
const nextEditsFor = (m: MockServer, doc: vscode.TextDocument) => nextEdits(m).filter((r) => userMessage(r.body).includes(`current_file_path: ${pathOf(doc)}\n`));
/** The mock's requests without their bodies, for failure messages. */
const seen = (m: MockServer): string =>
  JSON.stringify(m.requests.map((r) => `${r.method} ${r.path}${userMessage(r.body).includes(NEXT_EDIT_TAG) ? ' (next edit)' : ''}`));

/** Untitled documents: the test launch opens no folder, and Next Edit reads unsaved files and workspace files only. */
const open = async (lines: string[]): Promise<vscode.TextEditor> =>
  showAtEnd(await vscode.workspace.openTextDocument({ language: 'python', content: lines.join('\n') }));

/**
 * Types `text` one key at a time with VS Code's own `type` command, as the keyboard does: VS Code then asks for inline
 * completions by itself, FIM answers nothing and Next Edit is asked after the edit pause. (An edit made with
 * `editor.edit` asks for nothing. After an explicit trigger instead, VS Code takes the controller's own trigger for the
 * same version and cursor as already answered, so a Next Edit result would never be asked for.)
 */
async function typeKeys(editor: vscode.TextEditor, text: string): Promise<void> {
  const { document: doc, selection } = editor;
  // The first key replaces the selection.
  const length = doc.getText().length - (doc.offsetAt(selection.end) - doc.offsetAt(selection.start)) + text.length;
  for (const key of text) await vscode.commands.executeCommand('type', { text: key });
  assert.ok(await waitFor(() => editor.document.getText().length === length, 1000), `typing ${JSON.stringify(text)} did not reach ${editor.document.uri.toString()}`);
}

/** The rename's last step on CIRCLE: the user selects `r` on line 4 and types `radius`; the cursor stays on that line. */
async function openAndRename(): Promise<vscode.TextEditor> {
  const editor = await vscode.window.showTextDocument(await vscode.workspace.openTextDocument({ language: 'python', content: BEFORE_RENAME.join('\n') }));
  const at = BEFORE_RENAME[4].indexOf(' r ') + 1;
  editor.selection = new vscode.Selection(4, at, 4, at + 1);
  await typeKeys(editor, 'radius');
  assert.equal(editor.document.getText(), CIRCLE.join('\n'));
  assert.equal(editor.selection.active.line, 4);
  return editor;
}

/** One Strata backend for FIM and Next Edit on a mock whose FIM answer is empty. */
async function withNextEdit(nextEdit: MockOptions['nextEdit'], fn: (m: MockServer) => Promise<void>, settings: Record<string, unknown> = {}): Promise<void> {
  const m = await startMockServer({ alias: MODEL, chat: EMPTY_FIM, nextEdit });
  try {
    await configure({
      backends: [{ id: BACKEND_ID, kind: 'openai', hostFlavor: 'strata', baseUrl: `${m.baseUrl}/v1`, fimModel: MODEL }],
      'fim.backend': BACKEND_ID,
      'nextEdit.backend': BACKEND_ID,
      ...settings,
    });
    await fn(m);
  } finally {
    await m.close();
  }
}

suite('Next Edit', () => {
  let api: Api;

  suiteSetup(async () => {
    const ext = vscode.extensions.getExtension<Api>('raboo.ai-autocomplete')!;
    api = await ext.activate();
    // VS Code creates an editor's inline-completion controller when it is first needed, so the first key typed in a new
    // window asks for nothing. An explicit trigger in a scratch document creates it.
    const probe = registerProbe();
    try {
      await trigger(await showAtEnd(await vscode.workspace.openTextDocument({ language: 'plaintext', content: '' })));
    } finally {
      probe.dispose();
    }
    await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
    // Typed words would open the word-based suggest widget, and inline completions asked for while it shows skip FIM,
    // so Next Edit would not be asked.
    await vscode.workspace.getConfiguration('editor').update('quickSuggestions', { other: 'off', comments: 'off', strings: 'off' }, vscode.ConfigurationTarget.Global);
  });

  suiteTeardown(async () => {
    await vscode.workspace.getConfiguration('editor').update('quickSuggestions', undefined, vscode.ConfigurationTarget.Global);
  });

  teardown(async () => {
    // Untitled documents close without a save prompt; some tests open two.
    for (let i = 0; i < 5 && vscode.window.activeTextEditor; i++) await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
    await unconfigure(TOUCHED);
  });

  test('the probe matches the launch', () => {
    assert.ok(LAUNCH === 'main' || LAUNCH === 'proposed', `AI_AUTOCOMPLETE_TEST_LAUNCH is ${JSON.stringify(LAUNCH)}`);
    assert.equal(api.nativeNextEdit, LAUNCH === 'proposed');
  });

  test('an insertion after the cursor line shows as ghost text and is accepted', async () => {
    const accepted = [...GREETED, RETURN_LINE].join('\n');
    await withNextEdit({ content: fence([...GREETED, RETURN_LINE]) }, async (m) => {
      const editor = await open(GREET);

      await typeKeys(editor, 'e');
      assert.ok(await waitFor(() => nextEdits(m).length >= 1, REQUEST_WAIT_MS), `mock saw ${seen(m)}`);
      await commitWhen(editor, (t) => t === accepted);

      assert.equal(editor.document.getText(), accepted);
    });
  });

  testIn('proposed', 'a rename elsewhere is applied as an inline edit', async () => {
    await withNextEdit({ content: fence(RENAMED) }, async (m) => {
      const editor = await openAndRename();

      assert.ok(await waitFor(() => nextEdits(m).length >= 1, REQUEST_WAIT_MS), `mock saw ${seen(m)}`);
      // The commit command accepts a visible inline edit wherever it is, as Tab does once the cursor is there.
      await commitWhen(editor, (t) => t.split('\n')[7] === RENAMED[7]);

      assert.equal(editor.document.lineAt(7).text, 'def circle_circumference(radius):');
      assert.equal(editor.document.getText(), RENAMED.join('\n'));
    });
  });

  testIn('main', 'without the proposed API an edit elsewhere is not applied', async () => {
    await withNextEdit({ content: fence(RENAMED) }, async (m) => {
      const editor = await openAndRename();

      assert.ok(await waitFor(() => nextEdits(m).length >= 1, REQUEST_WAIT_MS), `mock saw ${seen(m)}`);
      await sleep(1000);
      await commit();

      assert.equal(editor.document.getText(), CIRCLE.join('\n'));
    });
  });

  test('an excluded file sends no Next Edit request', async () => {
    // With FIM off the controller asks after the edit pause on its own, so only its exclusion check can stop the request
    // (with FIM on, FIM's own exclusion would keep Next Edit from being asked). No language is disabled, so only the
    // `**/.env` entry of fim.disableInFiles excludes the file.
    await withNextEdit({ content: ['NO_CHANGE'] }, async (m) => {
      const env = await showAtEnd(await vscode.workspace.openTextDocument(vscode.Uri.parse('untitled:/next-edit-test/.env')));
      await typeKeys(env, 'API_KEY=1');
      await sleep(NO_REQUEST_WAIT_MS);
      assert.equal(nextEdits(m).length, 0, `mock saw ${seen(m)}`);

      // The same in a file that is not excluded asks, and the request carries nothing from the excluded one.
      const other = await open(['x = 1']);
      await typeKeys(other, '0');
      assert.ok(await waitFor(() => nextEdits(m).length >= 1, REQUEST_WAIT_MS), `mock saw ${seen(m)}`);
      const user = userMessage(nextEdits(m)[0].body);
      assert.ok(user.includes(`current_file_path: ${pathOf(other.document)}\n`), user);
      assert.ok(!user.includes(pathOf(env.document)) && !user.includes('API_KEY'), user);
    }, { 'fim.enabled': false, 'fim.disableInLanguages': [] });
  });

  test('typing fast sends one Next Edit request', async () => {
    await withNextEdit({ content: ['NO_CHANGE'] }, async (m) => {
      const editor = await open(['total = 1']);

      // Each key asks for inline completions and moves the cursor with a Keyboard selection event. Those events come with
      // a new document version and must not count as cursor moves: only FIM's empty answer for the last key lets Next Edit ask.
      for (const key of ' + 23') {
        await vscode.commands.executeCommand('type', { text: key });
        await sleep(30);
      }
      assert.ok(await waitFor(() => editor.document.getText() === 'total = 1 + 23', 1000), editor.document.getText());
      assert.ok(await waitFor(() => nextEdits(m).length >= 1, REQUEST_WAIT_MS), `mock saw ${seen(m)}`);
      await sleep(NO_REQUEST_WAIT_MS);

      assert.equal(nextEdits(m).length, 1, `mock saw ${seen(m)}`);
      assert.ok(askedAfterFim(m), `mock saw ${seen(m)}`);
    });
  });

  test('the Next Edit request carries the history diff', async () => {
    await withNextEdit({ content: ['NO_CHANGE'] }, async (m) => {
      const editor = await open(['total = 1']);

      await typeKeys(editor, ' + 2');
      assert.ok(await waitFor(() => nextEdits(m).length >= 1, REQUEST_WAIT_MS), `mock saw ${seen(m)}`);
      await sleep(HISTORY_IDLE_WAIT_MS);
      await typeKeys(editor, ' + 3');
      assert.ok(await waitFor(() => nextEdits(m).length >= 2, REQUEST_WAIT_MS), `mock saw ${seen(m)}`);

      const user = userMessage(nextEdits(m)[1].body);
      assert.ok(user.includes('<|edit_diff_history|>'), user);
      assert.ok(user.includes('@@ -'), user);
      assert.ok(user.includes(`--- ${pathOf(editor.document)}\n`), user);
    });
  });

  test('a cursor move after an edit asks Next Edit', async () => {
    await withNextEdit({ content: ['NO_CHANGE'] }, async (m) => {
      const editor = await open(['total = 1', 'count = 2']);

      // One `type` with several characters makes several edits, and VS Code reports the cursor after them more than
      // once, the last time in a version already reported. None of those reports is a cursor move.
      await vscode.commands.executeCommand('type', { text: ' + 3' });
      assert.ok(await waitFor(() => editor.document.lineAt(1).text === 'count = 2 + 3', 1000), editor.document.getText());
      assert.ok(await waitFor(() => nextEdits(m).length >= 1, REQUEST_WAIT_MS), `mock saw ${seen(m)}`);
      await sleep(ANSWERED_MS);
      // So the one request so far is the one FIM's empty answer let through.
      assert.equal(nextEdits(m).length, 1, `mock saw ${seen(m)}`);
      assert.ok(askedAfterFim(m), `mock saw ${seen(m)}`);
      await vscode.commands.executeCommand('cursorUp');
      assert.equal(editor.selection.active.line, 0);

      assert.ok(await waitFor(() => nextEdits(m).length >= 2, REQUEST_WAIT_MS), `mock saw ${seen(m)}`);
    });
  });

  test('a result for an old version is not shown', async () => {
    await withNextEdit({ content: fence([...GREETED, RETURN_LINE]), delayMs: SLOW_ANSWER_MS }, async (m) => {
      const editor = await open(GREET);

      await typeKeys(editor, 'e');
      assert.ok(await waitFor(() => nextEdits(m).length >= 1, REQUEST_WAIT_MS), `mock saw ${seen(m)}`);
      // Another key while the answer is on its way. The newer version gets its own request, which proposes nothing,
      // so only the answer for the version before this key could change the document.
      m.setNextEdit({ content: ['NO_CHANGE'] });
      await typeKeys(editor, 's');
      await sleep(SLOW_ANSWER_MS + 1000);
      await commit();

      assert.equal(editor.document.getText(), [GREET[0], `${GREET[1]}es`].join('\n'));
    });
  });

  testIn('main', "with extraContext off, other files' diffs are not sent", async () => {
    await withNextEdit({ content: ['NO_CHANGE'] }, async (m) => {
      /** Edits A, waits past the history idle time, edits B, and returns B's Next Edit request's user message. */
      const editAThenB = async (): Promise<{ a: vscode.TextDocument; b: vscode.TextDocument; user: string }> => {
        const a = await open(['a = 1']);
        await typeKeys(a, '0');
        assert.ok(await waitFor(() => nextEditsFor(m, a.document).length >= 1, REQUEST_WAIT_MS), `mock saw ${seen(m)}`);
        await sleep(HISTORY_IDLE_WAIT_MS);
        const b = await open(['b = 2']);
        await typeKeys(b, '0');
        assert.ok(await waitFor(() => nextEditsFor(m, b.document).length >= 1, REQUEST_WAIT_MS), `mock saw ${seen(m)}`);
        return { a: a.document, b: b.document, user: userMessage(nextEditsFor(m, b.document)[0].body) };
      };

      const on = await editAThenB();
      assert.ok(on.user.includes(`--- ${pathOf(on.a)}\n`), on.user);

      await configure({ 'fim.extraContext': false });
      const off = await editAThenB();
      assert.ok(!off.user.includes(`--- ${pathOf(off.a)}\n`), off.user);
      assert.ok(!off.user.includes(`code_snippet_file_path: ${pathOf(off.a)}\n`), off.user);
      // The current file's own diff is always sent.
      assert.ok(off.user.includes(`--- ${pathOf(off.b)}\n`), off.user);
    });
  });
});
