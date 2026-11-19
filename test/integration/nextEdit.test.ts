import * as assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { commit, commitWhen, configure, registerProbe, showAtEnd, sleep, trigger, unconfigure, waitFor } from './helpers';
import { NEXT_EDIT_TAG, SWEEP_TAG, ZETA_TAG, startMockServer, userMessage, type MockOptions, type MockServer, type RecordedRequest } from './mockServer';

/** The part of the extension's `activate()` result these tests use. */
interface Api {
  nativeNextEdit: boolean;
  /** The inline edit shown as decorations, if any. */
  outcomes(uri: string): { feature: string; kind: string }[];
  nextEditPending(): { uri: string; version: number; edit: { startLine: number; endLine: number; newLines: string[] } } | undefined;
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
const TOUCHED = ['backends', 'enabled', 'completions.backend', 'completions.enabled', 'completions.extraContext', 'completions.disableInLanguages', 'nextEdit.backend', 'nextEdit.format', 'nextEdit.display', 'nextEdit.definitions', 'completions.disableInFiles', 'privacy.localOnly'];
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

/** The model's edit of CIRCLE: lines 7 and 8 replaced. */
const RENAME_EDIT = { startLine: 7, endLine: 9, newLines: [RENAMED[7], RENAMED[8]] };
/** How long a decoration takes to appear once the mock has the request. */
const PENDING_WAIT_MS = 2000;
/** Past the rejection cooldown (REJECTION_COOLDOWN_MS is 5000) that Esc starts, during which nothing is asked. */
const REJECTION_COOLDOWN_WAIT_MS = 5200;

const isChat = (r: RecordedRequest): boolean => r.method === 'POST' && r.path === '/v1/chat/completions';
const isNextEdit = (r: RecordedRequest): boolean => isChat(r) && userMessage(r.body).includes(NEXT_EDIT_TAG);
const nextEdits = (m: MockServer) => m.requests.filter(isNextEdit);
/** FIM wins: Next Edit was first asked after FIM's request (a chat request without `<|code_to_edit|>`). */
const askedAfterFim = (m: MockServer): boolean => {
  const fim = m.requests.findIndex((r) => isChat(r) && !isNextEdit(r));
  return fim >= 0 && fim < m.requests.findIndex(isNextEdit);
};
/** The path the extension writes into prompts and diffs for a document. */
const pathOf = (doc: vscode.TextDocument): string => vscode.workspace.asRelativePath(doc.uri);
const nextEditsFor = (m: MockServer, doc: vscode.TextDocument) => nextEdits(m).filter((r) => userMessage(r.body).includes(`current_file_path: ${pathOf(doc)}\n`));
/** The mock's requests without their bodies, for failure messages. */
const seen = (m: MockServer): string =>
  JSON.stringify(m.requests.map((r) => `${r.method} ${r.path}${userMessage(r.body).includes(NEXT_EDIT_TAG) ? ' (next edit)' : ''}`));

/** The POST requests the mock saw on `path`. */
const posts = (m: MockServer, path: string): RecordedRequest[] => m.requests.filter((r) => r.method === 'POST' && r.path === path);
/** The POST requests on `path` that ask for an answer: warm-ups (n_predict 0) are left out. */
const answers = (m: MockServer, path: string): RecordedRequest[] => posts(m, path).filter((r) => r.body?.n_predict !== 0);
/** The warm-ups on `path`: raw requests that generate nothing. */
const warmUps = (m: MockServer, path: string): RecordedRequest[] => posts(m, path).filter((r) => r.body?.n_predict === 0);
/** Model names `auto` picks the raw formats for. */
const SWEEP_MODEL = 'sweep-next-edit-1.5b';
const ZETA_MODEL = 'zeta-2.1';

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

/** Runs a command that shows a quick pick and accepts its first item. */
async function pickFirst(command: string): Promise<void> {
  let done = false;
  const run = Promise.resolve(vscode.commands.executeCommand(command)).then(() => {
    done = true;
  });
  // Accepting before the quick pick shows does nothing, so keep accepting until the command finishes.
  const picked = await waitFor(() => {
    if (!done) void vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');
    return done;
  }, 3000);
  assert.ok(picked, `${command}: no quick pick item was accepted`);
  await run;
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
      backends: [{ id: BACKEND_ID, kind: 'openai', hostFlavor: 'strata', baseUrl: `${m.baseUrl}/v1`, model: MODEL }],
      'completions.backend': BACKEND_ID,
      'nextEdit.backend': BACKEND_ID,
      ...settings,
    });
    await fn(m);
  } finally {
    await m.close();
  }
}

/**
 * One backend for Next Edit only, with FIM off: the controller then asks after the edit pause on its own (a raw FIM
 * backend's answer would never be empty, so FIM would always win). The model comes from the mock's alias.
 */
async function withRawNextEdit(
  options: MockOptions,
  backend: (m: MockServer) => Record<string, unknown>,
  fn: (m: MockServer) => Promise<void>,
  settings: Record<string, unknown> = {},
): Promise<void> {
  const m = await startMockServer(options);
  try {
    await configure({
      backends: [{ id: BACKEND_ID, ...backend(m) }],
      'completions.enabled': false,
      'nextEdit.backend': BACKEND_ID,
      'nextEdit.format': 'auto',
      ...settings,
    });
    await fn(m);
  } finally {
    await m.close();
  }
}

const llamaCpp = (m: MockServer): Record<string, unknown> => ({ kind: 'llamacpp', baseUrl: m.baseUrl });
const lmStudio = (m: MockServer): Record<string, unknown> => ({ kind: 'openai', hostFlavor: 'lmstudio', baseUrl: `${m.baseUrl}/v1` });

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

  testIn('main', 'display native drops an edit elsewhere without the proposed API', async () => {
    await withNextEdit({ content: fence(RENAMED) }, async (m) => {
      const editor = await openAndRename();

      assert.ok(await waitFor(() => nextEdits(m).length >= 1, REQUEST_WAIT_MS), `mock saw ${seen(m)}`);
      await sleep(1000);
      await commit();

      assert.equal(editor.document.getText(), CIRCLE.join('\n'));
      assert.equal(api.nextEditPending(), undefined);
    }, { 'nextEdit.display': 'native' });
  });

  testIn('main', 'without the proposed API, auto shows an edit elsewhere as decorations', async () => {
    await withNextEdit({ content: fence(RENAMED) }, async (m) => {
      const editor = await openAndRename();

      assert.ok(await waitFor(() => nextEdits(m).length >= 1, REQUEST_WAIT_MS), `mock saw ${seen(m)}`);
      assert.ok(await waitFor(() => api.nextEditPending() !== undefined, PENDING_WAIT_MS), 'no pending edit');
      assert.deepEqual(api.nextEditPending()?.edit, RENAME_EDIT);
      assert.equal(api.nextEditPending()?.uri, editor.document.uri.toString());
    }, { 'nextEdit.display': 'auto' });
  });

  /** CIRCLE renamed by the user, with the model's rename of the functions below shown as decorations. */
  async function withPendingRename(fn: (editor: vscode.TextEditor, m: MockServer) => Promise<void>): Promise<void> {
    await withNextEdit({ content: fence(RENAMED) }, async (m) => {
      const editor = await openAndRename();
      assert.ok(await waitFor(() => nextEdits(m).length >= 1, REQUEST_WAIT_MS), `mock saw ${seen(m)}`);
      assert.ok(await waitFor(() => api.nextEditPending() !== undefined, PENDING_WAIT_MS), 'no pending edit');
      assert.deepEqual(api.nextEditPending()?.edit, RENAME_EDIT);
      await fn(editor, m);
    }, { 'nextEdit.display': 'decorations' });
  }

  test('the edit is pending and Tab jumps, then applies', async () => {
    await withPendingRename(async (editor) => {
      assert.equal(editor.selection.active.line, 4);
      await vscode.commands.executeCommand('aiAutocomplete.nextEditTab');
      // The first Tab only moves the cursor to the edit.
      assert.equal(editor.selection.active.line, 7);
      assert.equal(editor.document.getText(), CIRCLE.join('\n'));
      assert.deepEqual(api.nextEditPending()?.edit, RENAME_EDIT);

      await vscode.commands.executeCommand('aiAutocomplete.nextEditTab');
      assert.equal(editor.document.getText(), RENAMED.join('\n'));
      assert.equal(api.nextEditPending(), undefined);
      // The cursor ends after the last new line.
      assert.equal(editor.selection.active.line, 8);
      assert.equal(editor.selection.active.character, RENAMED[8].length);
    });
  });

  test('Esc dismisses a pending edit', async () => {
    await withPendingRename(async (editor, m) => {
      await vscode.commands.executeCommand('aiAutocomplete.nextEditDismiss');
      const dismissedAt = Date.now();
      assert.equal(api.nextEditPending(), undefined);
      await vscode.commands.executeCommand('aiAutocomplete.nextEditTab');
      assert.equal(editor.document.getText(), CIRCLE.join('\n'));

      // Esc is a rejection: a cursor move shortly after the edit would ask again, but not during the cooldown.
      const asked = nextEdits(m).length;
      await vscode.commands.executeCommand('cursorUp');
      assert.equal(editor.selection.active.line, 3);
      await sleep(NO_REQUEST_WAIT_MS);
      assert.equal(nextEdits(m).length, asked, `mock saw ${seen(m)}`);
      // The rest of the cooldown, which would keep the next tests' requests from being sent.
      await sleep(Math.max(0, dismissedAt + REJECTION_COOLDOWN_WAIT_MS - Date.now()));
    });
  });

  test('typing clears a pending edit', async () => {
    await withPendingRename(async (editor, m) => {
      // Otherwise the request for the typed version would show the rename again.
      m.setNextEdit({ content: ['NO_CHANGE'] });
      editor.selection = new vscode.Selection(0, CIRCLE[0].length, 0, CIRCLE[0].length);
      await typeKeys(editor, ' ');
      const typed = CIRCLE.map((l, i) => (i === 0 ? `${l} ` : l)).join('\n');
      assert.equal(editor.document.getText(), typed);
      assert.equal(api.nextEditPending(), undefined);

      await vscode.commands.executeCommand('aiAutocomplete.nextEditTab');
      await vscode.commands.executeCommand('aiAutocomplete.nextEditTab');
      assert.equal(editor.document.getText(), typed);
    });
  });

  test('typing the suggestion keeps the rest of a pending edit', async () => {
    await withPendingRename(async (editor, m) => {
      // A request for a typed version proposes nothing, so only the kept edit can be pending.
      m.setNextEdit({ content: ['NO_CHANGE'] });
      // After `(r` on line 7, where the rename inserts `adius`.
      const at = CIRCLE[7].indexOf('(r') + 2;
      editor.selection = new vscode.Selection(7, at, 7, at);
      await typeKeys(editor, 'adi');
      const typed = CIRCLE.map((l, i) => (i === 7 ? 'def circle_circumference(radi):' : l)).join('\n');
      assert.equal(editor.document.getText(), typed);
      assert.deepEqual(api.nextEditPending()?.edit, RENAME_EDIT);
      assert.equal(api.nextEditPending()?.version, editor.document.version);
      // Still pending after the edit pause and FIM's answer for the typed version.
      await sleep(NO_REQUEST_WAIT_MS);
      assert.deepEqual(api.nextEditPending()?.edit, RENAME_EDIT);

      await vscode.commands.executeCommand('aiAutocomplete.nextEditTab');
      assert.equal(editor.document.getText(), RENAMED.join('\n'));
      assert.equal(api.nextEditPending(), undefined);
    });
  });

  test('a snooze clears a pending edit', async () => {
    await withPendingRename(async (editor) => {
      try {
        await pickFirst('aiAutocomplete.snooze'); // "15 minutes"
        assert.equal(api.nextEditPending(), undefined);
        await vscode.commands.executeCommand('aiAutocomplete.nextEditTab');
        assert.equal(editor.document.getText(), CIRCLE.join('\n'));
      } finally {
        await pickFirst('aiAutocomplete.snooze'); // "Resume now"
      }
    });
  });

  testIn('proposed', 'display decorations wins over native', async () => {
    await withPendingRename(async (editor) => {
      // The commit command would accept a visible inline edit wherever it is: none is shown.
      for (let i = 0; i < 20; i++) {
        await commit();
        await sleep(50);
      }
      assert.equal(editor.document.getText(), CIRCLE.join('\n'));
      assert.deepEqual(api.nextEditPending()?.edit, RENAME_EDIT);
    });
  });

  test('Next Edit asks when local-only blocks a hosted completion backend', async () => {
    // FIM shows nothing without an answer (it never sends), and that still lets Next Edit ask on the local backend.
    // 203.0.113.1 is a documentation address: not local, and never contacted.
    const m = await startMockServer({ alias: MODEL, chat: EMPTY_FIM, nextEdit: { content: fence([...GREETED, RETURN_LINE]) } });
    try {
      await configure({
        backends: [
          { id: 'hosted', kind: 'openai', baseUrl: 'http://203.0.113.1/v1', model: MODEL, use: 'completions' },
          { id: BACKEND_ID, kind: 'openai', hostFlavor: 'strata', baseUrl: `${m.baseUrl}/v1`, model: MODEL, use: 'nextEdit' },
        ],
        'completions.backend': 'hosted',
        'nextEdit.backend': BACKEND_ID,
        'privacy.localOnly': true,
      });
      const editor = await open(GREET);
      await typeKeys(editor, 'e');
      assert.ok(await waitFor(() => nextEdits(m).length >= 1, REQUEST_WAIT_MS), `mock saw ${seen(m)}`);
      assert.equal(m.requests.filter((r) => isChat(r) && !isNextEdit(r)).length, 0, `mock saw ${seen(m)}`);
    } finally {
      await m.close();
    }
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
    }, { 'completions.enabled': false, 'completions.disableInLanguages': [] });
  });

  test('the AI Autocomplete switch off sends no Next Edit request; turned on again, Next Edit asks', async () => {
    // With FIM off the controller asks after the edit pause on its own, so only the switch can stop the request.
    await withNextEdit({ content: ['NO_CHANGE'] }, async (m) => {
      const editor = await open(['x = 1']);
      await typeKeys(editor, '0');
      await sleep(NO_REQUEST_WAIT_MS);
      assert.equal(nextEdits(m).length, 0, `mock saw ${seen(m)}`);

      // Turning it on takes fresh snapshots, so the next edit has a history and asks.
      await vscode.commands.executeCommand('aiAutocomplete.toggleEnabled');
      await typeKeys(editor, '1');
      assert.ok(await waitFor(() => nextEdits(m).length >= 1, REQUEST_WAIT_MS), `mock saw ${seen(m)}`);
    }, { enabled: false, 'completions.enabled': false });
  });

  test('a region with a Markdown code block sends no Next Edit request', async () => {
    // A ``` line in the region would end the answer's fence early. With FIM off the controller asks after the edit pause
    // on its own, so only the region check can stop the request.
    await withNextEdit({ content: ['NO_CHANGE'] }, async (m) => {
      const markdown = async (lines: string[]) => showAtEnd(await vscode.workspace.openTextDocument({ language: 'markdown', content: lines.join('\n') }));
      const fenced = await markdown(['# Install', '', '```bash', 'npm install', '```', '', 'Then run the tes']);
      await typeKeys(fenced, 't');
      await sleep(NO_REQUEST_WAIT_MS);
      assert.equal(nextEdits(m).length, 0, `mock saw ${seen(m)}`);

      // The same without the code block asks.
      const plain = await markdown(['# Install', '', 'Then run the tes']);
      await typeKeys(plain, 't');
      assert.ok(await waitFor(() => nextEdits(m).length >= 1, REQUEST_WAIT_MS), `mock saw ${seen(m)}`);
    }, { 'completions.enabled': false, 'completions.disableInLanguages': [] });
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

      await configure({ 'completions.extraContext': false });
      const off = await editAThenB();
      assert.ok(!off.user.includes(`--- ${pathOf(off.a)}\n`), off.user);
      assert.ok(!off.user.includes(`code_snippet_file_path: ${pathOf(off.a)}\n`), off.user);
      // The current file's own diff is always sent.
      assert.ok(off.user.includes(`--- ${pathOf(off.b)}\n`), off.user);
    });
  });

  test('sweep on llama.cpp', async () => {
    // The window is the whole two-line document; the answer adds a line after the cursor line, so it shows as ghost text.
    const accepted = [...GREETED, RETURN_LINE].join('\n');
    await withRawNextEdit({ alias: SWEEP_MODEL, nextEditRaw: { content: [`${GREETED.join('\n')}\n`, `${RETURN_LINE}\n`] } }, llamaCpp, async (m) => {
      const editor = await open(GREET);

      await typeKeys(editor, 'e');
      assert.ok(await waitFor(() => answers(m, '/completion').length >= 1, REQUEST_WAIT_MS), `mock saw ${seen(m)}`);
      await commitWhen(editor, (t) => t === accepted);

      assert.equal(editor.document.getText(), accepted);
      const body = answers(m, '/completion')[0].body ?? {};
      assert.ok(typeof body.prompt === 'string' && body.prompt.includes('<|file_sep|>current/') && body.prompt.includes(SWEEP_TAG), JSON.stringify(body.prompt));
      assert.equal(body.temperature, 0);
      assert.ok(Array.isArray(body.stop) && body.stop.includes('<|file_sep|>'), JSON.stringify(body.stop));
      assert.ok(!('top_p' in body), JSON.stringify(body));
      assert.equal(posts(m, '/v1/chat/completions').length, 0, `mock saw ${seen(m)}`);
    });
  });

  test('with completions off, an active editor warms the Next Edit slot with n_predict 0 and nothing shows', async () => {
    await withRawNextEdit({ alias: SWEEP_MODEL, nextEditRaw: { content: [`${GREETED.join('\n')}\n`] } }, llamaCpp, async (m) => {
      const editor = await open(GREET);

      assert.ok(await waitFor(() => warmUps(m, '/completion').length >= 1, REQUEST_WAIT_MS), `no warm-up; mock saw ${seen(m)}`);
      const body = warmUps(m, '/completion')[0].body ?? {};
      assert.ok(typeof body.prompt === 'string' && body.prompt.includes(SWEEP_TAG), JSON.stringify(body.prompt));
      await sleep(NO_REQUEST_WAIT_MS);
      assert.equal(answers(m, '/completion').length, 0, `a warm-up is the only request; mock saw ${seen(m)}`);
      assert.equal(editor.document.getText(), GREET.join('\n'));
      assert.equal(api.nextEditPending(), undefined);
    });
  });

  test('a Next Edit answer with completions off records a nextEdit shown outcome', async () => {
    await withRawNextEdit({ alias: SWEEP_MODEL, nextEditRaw: { content: [`${GREETED.join('\n')}\n`, `${RETURN_LINE}\n`] } }, llamaCpp, async (m) => {
      const editor = await open(GREET);
      await typeKeys(editor, 'e');
      assert.ok(await waitFor(() => answers(m, '/completion').length >= 1, REQUEST_WAIT_MS), `mock saw ${seen(m)}`);
      const uri = editor.document.uri.toString();
      assert.ok(await waitFor(() => api.outcomes(uri).some((o) => o.feature === 'nextEdit' && o.kind === 'shown'), REQUEST_WAIT_MS), JSON.stringify(api.outcomes(uri)));
    });
  });

  test('zeta21 on an OpenAI-compatible server', async () => {
    const accepted = [...GREETED, RETURN_LINE].join('\n');
    await withRawNextEdit({ alias: ZETA_MODEL, nextEditRaw: { content: ['<|marker_1|>', accepted, '<|marker_2|>'] } }, lmStudio, async (m) => {
      const editor = await open(GREET);

      await typeKeys(editor, 'e');
      assert.ok(await waitFor(() => posts(m, '/v1/completions').length >= 1, REQUEST_WAIT_MS), `mock saw ${seen(m)}`);
      await commitWhen(editor, (t) => t === accepted);

      assert.equal(editor.document.getText(), accepted);
      const body = posts(m, '/v1/completions')[0].body ?? {};
      assert.ok(typeof body.prompt === 'string' && body.prompt.includes(ZETA_TAG) && body.prompt.includes('<|marker_1|>'), JSON.stringify(body.prompt));
      assert.equal(body.temperature, 0);
      assert.equal(body.model, ZETA_MODEL);
      assert.ok(Array.isArray(body.stop) && body.stop.includes('<[end▁of▁sentence]>'), JSON.stringify(body.stop));
      assert.ok(!('top_p' in body) && !('top_k' in body), JSON.stringify(body));
      assert.equal(posts(m, '/v1/chat/completions').length, 0, `mock saw ${seen(m)}`);
    });
  });

  /** The Zeta answer for GREET: the return line, with the predicted cursor before `message`. */
  const ZETA_CURSOR_ANSWER = ['<|marker_1|>', `${GREETED.join('\n')}\n    return <|user_cursor|>message`, '<|marker_2|>'];

  test('accepting a Zeta ghost text moves the cursor where the answer put it', async () => {
    const accepted = [...GREETED, RETURN_LINE].join('\n');
    await withRawNextEdit({ alias: ZETA_MODEL, nextEditRaw: { content: ZETA_CURSOR_ANSWER } }, lmStudio, async (m) => {
      const editor = await open(GREET);

      await typeKeys(editor, 'e');
      assert.ok(await waitFor(() => posts(m, '/v1/completions').length >= 1, REQUEST_WAIT_MS), `mock saw ${seen(m)}`);
      await commitWhen(editor, (t) => t === accepted);

      assert.equal(editor.document.getText(), accepted);
      const at = new vscode.Position(2, '    return '.length);
      assert.ok(await waitFor(() => editor.selection.active.isEqual(at), 1000), `cursor at ${JSON.stringify(editor.selection.active)}`);
    });
  });

  test('an accept after the document changed leaves the cursor where it is', async () => {
    await withRawNextEdit({ alias: ZETA_MODEL, nextEditRaw: { content: ZETA_CURSOR_ANSWER } }, lmStudio, async (m) => {
      const editor = await open(GREET);

      await typeKeys(editor, 'e');
      const uri = editor.document.uri.toString();
      assert.ok(await waitFor(() => api.outcomes(uri).some((o) => o.feature === 'nextEdit' && o.kind === 'shown'), REQUEST_WAIT_MS), `mock saw ${seen(m)}`);
      // A character the suggestion does not have: the document no longer holds the text the item would add.
      await typeKeys(editor, 'x');
      const typed = new vscode.Position(1, GREETED[1].length + 1);
      assert.ok(editor.selection.active.isEqual(typed));
      await vscode.commands.executeCommand('aiAutocomplete.nextEditAccepted');

      assert.equal(editor.document.getText(), [GREET[0], `${GREETED[1]}x`].join('\n'));
      assert.ok(editor.selection.active.isEqual(typed), `cursor at ${JSON.stringify(editor.selection.active)}`);
    });
  });

  test('Tab on a Zeta decoration applies it and moves the cursor where the answer put it', async () => {
    const line8 = RENAMED[8].replace('radius', '<|user_cursor|>radius');
    const answer = RENAMED.map((l, i) => (i === 8 ? line8 : l)).join('\n');
    await withRawNextEdit({ alias: ZETA_MODEL, nextEditRaw: { content: ['<|marker_1|>', answer, '<|marker_2|>'] } }, lmStudio, async (m) => {
      const editor = await openAndRename();
      assert.ok(await waitFor(() => posts(m, '/v1/completions').length >= 1, REQUEST_WAIT_MS), `mock saw ${seen(m)}`);
      assert.ok(await waitFor(() => api.nextEditPending() !== undefined, PENDING_WAIT_MS), 'no pending edit');
      assert.deepEqual(api.nextEditPending()?.edit, RENAME_EDIT);

      await vscode.commands.executeCommand('aiAutocomplete.nextEditTab');
      await vscode.commands.executeCommand('aiAutocomplete.nextEditTab');

      assert.equal(editor.document.getText(), RENAMED.join('\n'));
      assert.equal(editor.selection.active.line, 8);
      assert.equal(editor.selection.active.character, RENAMED[8].indexOf('radius'));
    }, { 'nextEdit.display': 'decorations' });
  });

  test('a reserved string sends nothing', async () => {
    // `<|file_sep|>` in the window would become one of Sweep's control tokens.
    await withRawNextEdit({ alias: SWEEP_MODEL, nextEditRaw: { content: ['x\n'] } }, llamaCpp, async (m) => {
      const reserved = await open(['SEP = "<|file_sep|>"', 'total = 1']);
      await typeKeys(reserved, '0');
      await sleep(NO_REQUEST_WAIT_MS);
      assert.equal(m.requests.filter((r) => r.method === 'POST').length, 0, `mock saw ${seen(m)}`);

      // The same without the reserved string asks.
      const plain = await open(['SEP = "file"', 'total = 1']);
      await typeKeys(plain, '0');
      assert.ok(await waitFor(() => posts(m, '/completion').length >= 1, REQUEST_WAIT_MS), `mock saw ${seen(m)}`);
    });
  });

  test('a chat-only backend skips raw formats', async () => {
    // Strata has no raw completion route, so the sweep format cannot be sent to it.
    await withNextEdit({ content: ['NO_CHANGE'] }, async (m) => {
      const editor = await open(['total = 1']);

      await typeKeys(editor, '0');
      assert.ok(await waitFor(() => m.requests.some((r) => isChat(r) && !isNextEdit(r)), REQUEST_WAIT_MS), `mock saw ${seen(m)}`);
      await sleep(NO_REQUEST_WAIT_MS);
      assert.equal(nextEdits(m).length, 0, `mock saw ${seen(m)}`);
      assert.equal(posts(m, '/v1/completions').length + posts(m, '/completion').length, 0, `mock saw ${seen(m)}`);

      // With the format back on auto (chatXtab), the same asks.
      await configure({ 'nextEdit.format': 'auto' });
      await typeKeys(editor, '1');
      assert.ok(await waitFor(() => nextEdits(m).length >= 1, REQUEST_WAIT_MS), `mock saw ${seen(m)}`);
    }, { 'nextEdit.format': 'sweep' });
  });

  suite('definitions as context', () => {
    /** A file in the workspace folder (its prompt path is its name) and one on disk outside it. */
    const SHAPES = [
      'import math', '', '', 'class Shape:', '    def area(self):', '        return 0', '', '',
      'def circle_area(radius):', '    return math.pi * radius ** 2', '', '', 'def unrelated():', '    return 1',
    ];
    /** circle_area's symbol (lines 8 and 9) whole, and `...` because the file continues. */
    const EXCERPT = 'def circle_area(radius):\n    return math.pi * radius ** 2\n...';
    const USES = ['total = circle_area(2)', 'x = 1'];
    let dir: string;
    let shapes: vscode.Uri;
    let outside: vscode.Uri;
    const registered: vscode.Disposable[] = [];

    suiteSetup(async () => {
      dir = mkdtempSync(join(tmpdir(), 'ai-autocomplete-defs-'));
      const folder = vscode.workspace.workspaceFolders?.[0];
      assert.ok(folder, 'the integration launch has a workspace folder');
      shapes = vscode.Uri.joinPath(folder.uri, 'shapes.py');
      outside = vscode.Uri.file(join(dir, 'outside.py'));
      for (const u of [shapes, outside]) writeFileSync(u.fsPath, `${SHAPES.join('\n')}\n`);
      // Opened once, so the first lookup is not slowed by reading the file.
      await vscode.workspace.openTextDocument(shapes);
      await vscode.workspace.openTextDocument(outside);
    });

    suiteTeardown(() => {
      rmSync(dir, { recursive: true, force: true });
      rmSync(shapes.fsPath, { force: true });
    });

    teardown(() => {
      for (const d of registered.splice(0)) d.dispose();
    });

    /** A language server for the test: `circle_area` in untitled Python files is defined in shapes.py, whose symbols it lists. */
    function registerProviders(definition?: () => Promise<vscode.Location | undefined> | vscode.Location | undefined): void {
      registered.push(
        vscode.languages.registerDefinitionProvider({ language: 'python', scheme: 'untitled' }, {
          provideDefinition: (doc, pos) => {
            if (definition) return definition();
            const word = doc.getWordRangeAtPosition(pos);
            return word && doc.getText(word) === 'circle_area' ? new vscode.Location(shapes, new vscode.Position(8, 4)) : undefined;
          },
        }),
        vscode.languages.registerDocumentSymbolProvider({ language: 'python', scheme: 'file' }, {
          provideDocumentSymbols: () => {
            const sym = (name: string, start: number, end: number, children: vscode.DocumentSymbol[] = []) => {
              const range = new vscode.Range(start, 0, end, SHAPES[end].length);
              const s = new vscode.DocumentSymbol(name, '', vscode.SymbolKind.Function, range, range);
              s.children = children;
              return s;
            };
            return [sym('Shape', 3, 5, [sym('area', 4, 5)]), sym('circle_area', 8, 9), sym('unrelated', 12, 13)];
          },
        }),
      );
    }

    /**
     * Types in a document using circle_area until a request whose prompt (`prompt` reads it) has the definition, at most
     * twice: a slow first lookup is cut at 100 ms and fills the cache for the next request. Returns the last prompt.
     */
    async function askUntilDefinition(count: () => number, prompt: () => string, expected: string): Promise<string> {
      const editor = await open(USES);
      for (const key of ['0', '1']) {
        const before = count();
        await typeKeys(editor, key);
        assert.ok(await waitFor(() => count() > before, REQUEST_WAIT_MS), `no request after typing ${key}`);
        if (prompt().includes(expected)) break;
      }
      return prompt();
    }

    test('a definition in another file reaches a Zeta prompt as a <filename> section', async () => {
      registerProviders();
      await withRawNextEdit({ alias: ZETA_MODEL, nextEditRaw: { content: ['NO_EDITS'] } }, lmStudio, async (m) => {
        const zeta = () => posts(m, '/v1/completions');
        const last = () => String(zeta()[zeta().length - 1]?.body?.prompt ?? '');
        const prompt = await askUntilDefinition(() => zeta().length, last, `<filename>shapes.py\n${EXCERPT}\n`);
        assert.ok(prompt.includes(`<filename>shapes.py\n${EXCERPT}\n`), prompt);
        assert.ok(!prompt.includes('def unrelated'), prompt);
      });
    });

    test('a definition in another file reaches the chatXtab snippets section', async () => {
      registerProviders();
      await withNextEdit({ content: ['NO_CHANGE'] }, async (m) => {
        const last = () => userMessage(nextEdits(m)[nextEdits(m).length - 1]?.body);
        const expected = `code_snippet_file_path: shapes.py\n${EXCERPT}\n<|/recently_viewed_code_snippet|>`;
        const user = await askUntilDefinition(() => nextEdits(m).length, last, expected);
        const section = user.slice(user.indexOf('<|recently_viewed_code_snippets|>'), user.indexOf('<|/recently_viewed_code_snippets|>'));
        assert.ok(section.includes(expected), user);
      });
    });

    /** Asks twice in a document using circle_area and returns both prompts' user messages, which must not have the definition. */
    async function askWithoutDefinition(settings: Record<string, unknown>): Promise<void> {
      registerProviders();
      await withNextEdit({ content: ['NO_CHANGE'] }, async (m) => {
        const editor = await open(USES);
        for (const key of ['0', '1']) {
          const before = nextEdits(m).length;
          await typeKeys(editor, key);
          assert.ok(await waitFor(() => nextEdits(m).length > before, REQUEST_WAIT_MS), `mock saw ${seen(m)}`);
        }
        for (const r of nextEdits(m)) assert.ok(!userMessage(r.body).includes('def circle_area'), userMessage(r.body));
      }, settings);
    }

    testIn('main', 'with nextEdit.definitions off, no definition is sent', async () => {
      await askWithoutDefinition({ 'nextEdit.definitions': false });
    });

    testIn('main', 'with extra context off, no definition is sent', async () => {
      await askWithoutDefinition({ 'completions.extraContext': false });
    });

    testIn('main', 'a definition in a file outside the workspace is not sent', async () => {
      registerProviders(() => new vscode.Location(outside, new vscode.Position(8, 4)));
      await withNextEdit({ content: ['NO_CHANGE'] }, async (m) => {
        const editor = await open(USES);
        for (const key of ['0', '1']) {
          const before = nextEdits(m).length;
          await typeKeys(editor, key);
          assert.ok(await waitFor(() => nextEdits(m).length > before, REQUEST_WAIT_MS), `mock saw ${seen(m)}`);
        }
        for (const r of nextEdits(m)) {
          const user = userMessage(r.body);
          assert.ok(!user.includes('def circle_area') && !user.includes('outside.py'), user);
        }
      });
    });

    test('an empty lookup is not cached: the next request gets the definition', async () => {
      let ready = false;
      registerProviders(() => (ready ? new vscode.Location(shapes, new vscode.Position(8, 4)) : undefined));
      await withNextEdit({ content: ['NO_CHANGE'] }, async (m) => {
        const editor = await open(USES);
        await typeKeys(editor, '0');
        assert.ok(await waitFor(() => nextEdits(m).length >= 1, REQUEST_WAIT_MS), `mock saw ${seen(m)}`);
        assert.ok(!userMessage(nextEdits(m)[0].body).includes('def circle_area'));
        ready = true;
        const last = () => userMessage(nextEdits(m)[nextEdits(m).length - 1]?.body);
        const expected = `code_snippet_file_path: shapes.py\n${EXCERPT}\n<|/recently_viewed_code_snippet|>`;
        const user = await askUntilDefinition(() => nextEdits(m).length, last, expected);
        assert.ok(user.includes(expected), user);
      });
    });

    testIn('main', 'a definition in an excluded file is not sent', async () => {
      await askWithoutDefinition({ 'completions.disableInFiles': ['**/shapes.py'] });
    });

    testIn('main', 'a definition provider that never answers does not hold up the request', async () => {
      registerProviders(() => new Promise<undefined>(() => undefined));
      await withNextEdit({ content: ['NO_CHANGE'] }, async (m) => {
        // A recently viewed file, whose snippet still goes with the request.
        const viewed = await open(['helper_value = 42']);
        const editor = await open(USES);
        await typeKeys(editor, '0');
        const typed = Date.now();
        assert.ok(await waitFor(() => nextEdits(m).length >= 1, REQUEST_WAIT_MS), `mock saw ${seen(m)}`);
        // The 400 ms edit pause, FIM's answer and the 100 ms cap, with room for a slow machine.
        const elapsed = Date.now() - typed;
        assert.ok(elapsed < 2000, `the request came ${elapsed} ms after typing`);
        const user = userMessage(nextEdits(m)[0].body);
        assert.ok(user.includes(`code_snippet_file_path: ${pathOf(viewed.document)}\nhelper_value = 42`), user);
        assert.ok(!user.includes('def circle_area'), user);
      });
    });
  });
});
