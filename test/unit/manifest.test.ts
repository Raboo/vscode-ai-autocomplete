import { expect, test } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { DEFAULT_DISABLE_IN_FILES, FIM_LIMITS, NEXT_EDIT_DISPLAYS, NEXT_EDIT_FORMATS, THINKING_STRATEGIES } from '../../src/config/settings';
import { COMPLETIONS_KEYS } from '../../src/config/rename';
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
/** Every setting, from one configuration object or from titled sections. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const settingProps: Record<string, any> = Object.assign({}, ...[pkg.contributes.configuration].flat().map((s: { properties: object }) => s.properties));
test('identity', () => {
  expect(pkg.publisher).toBe('raboo'); expect(pkg.name).toBe('ai-autocomplete');
  expect(pkg.license).toBe('Apache-2.0'); expect(pkg.author.name).toBe('Elias Abacioglu');
  expect(pkg.enabledApiProposals).toEqual(['inlineCompletionsAdditions']);
  expect(Object.keys(pkg.dependencies ?? {})).toEqual(['diff', 'jsonc-parser']);
});
test('NOTICE credits the original author', () => {
  expect(readFileSync('NOTICE', 'utf8')).toContain('Originally created by Elias Abacioglu');
});
test('bundle exists after build', () => { expect(readFileSync('dist/extension.js', 'utf8')).toContain('activate'); });
test('webview bundle is built and packaged', () => {
  expect(existsSync('dist/webview/backends.js')).toBe(true);
  expect(existsSync('dist/webview/backends.css')).toBe(true);
  expect(readFileSync('.vscodeignore', 'utf8').split(/\r?\n/).map((l) => l.trim())).toContain('!dist/webview/**');
});
test('commands are categorised and the internal commands are hidden from the palette', () => {
  const cmds = pkg.contributes.commands as { command: string; category: string }[];
  expect(cmds.map((c) => c.command).sort()).toEqual(
    ['about', 'accepted', 'enableNativeNextEdit', 'manageBackends', 'menu', 'nextEditAccepted', 'nextEditDismiss', 'nextEditTab', 'openSettings', 'removeLocalModels', 'retry', 'selectBackend', 'selectNextEditBackend', 'setApiKey', 'setUpLocalModel', 'showLog', 'snooze', 'stopLocalModels', 'toggleEnabled', 'whyNoSuggestion']
      .map((c) => `aiAutocomplete.${c}`)
      .sort(),
  );
  expect(cmds.every((c) => c.category === 'AI Autocomplete')).toBe(true);
  for (const id of ['accepted', 'nextEditAccepted', 'nextEditTab', 'nextEditDismiss']) {
    expect(pkg.contributes.menus.commandPalette).toContainEqual({ command: `aiAutocomplete.${id}`, when: 'false' });
  }
  expect(pkg.contributes.menus.commandPalette).not.toContainEqual({ command: 'aiAutocomplete.openSettings', when: 'false' });
  expect((pkg.contributes.commands as { command: string; title: string }[]).find((c) => c.command === 'aiAutocomplete.openSettings')?.title).toBe('Open Settings');
  expect((pkg.contributes.commands as { command: string; title: string }[]).find((c) => c.command === 'aiAutocomplete.stopLocalModels')?.title).toBe('Stop Local Models');
  expect((pkg.contributes.commands as { command: string; title: string }[]).find((c) => c.command === 'aiAutocomplete.setUpLocalModel')?.title).toBe('Set Up Local Model');
  expect((pkg.contributes.commands as { command: string; title: string }[]).find((c) => c.command === 'aiAutocomplete.removeLocalModels')?.title).toBe('Remove Downloaded Models');
});
test('Tab and Esc act on a pending Next Edit decoration only, never over a suggestion, inline edit, snippet, selection or multiple cursors', () => {
  expect(pkg.contributes.keybindings).toEqual([
    {
      command: 'aiAutocomplete.nextEditTab',
      key: 'tab',
      when: 'editorTextFocus && aiAutocomplete.nextEditPending && !editorHasSelection && !editorHasMultipleSelections && !inlineSuggestionVisible && !inlineEditIsVisible && !suggestWidgetVisible && !inSnippetMode && !editorTabMovesFocus && !editorReadonly',
    },
    {
      command: 'aiAutocomplete.nextEditDismiss',
      key: 'escape',
      when: 'editorTextFocus && aiAutocomplete.nextEditPending && !editorHasMultipleSelections && !suggestWidgetVisible && !inSnippetMode && !inlineSuggestionVisible',
    },
  ]);
});
test('the backends setting links to the Backends page', () => {
  const backends = settingProps['aiAutocomplete.backends'];
  expect(backends.markdownDescription.startsWith('[Manage backends](command:aiAutocomplete.manageBackends)')).toBe(true);
  const manage = (pkg.contributes.commands as { command: string; title: string }[]).find((c) => c.command === 'aiAutocomplete.manageBackends');
  expect(manage?.title).toBe('Manage Backends');
});
test('backends schema completions limits match FIM_LIMITS', () => {
  const props = settingProps['aiAutocomplete.backends'].items.properties.completions.properties;
  for (const [key, lim] of Object.entries(FIM_LIMITS)) {
    const p = props[key];
    expect(p, key).toBeDefined();
    if (lim.exclusiveMin) { expect(p.exclusiveMinimum, key).toBe(lim.min); expect(p.minimum, key).toBeUndefined(); } else expect(p.minimum, key).toBe(lim.min);
    expect(p.maximum, key).toBe(lim.max);
    expect(p.type === 'integer', key).toBe(lim.integer);
  }
});
test('completions.thinking schema enum equals THINKING_STRATEGIES; modelOverrides description names thinking', () => {
  const props = settingProps;
  expect(props['aiAutocomplete.backends'].items.properties.completions.properties.thinking.enum).toEqual([...THINKING_STRATEGIES]);
  expect(props['aiAutocomplete.modelOverrides'].markdownDescription).toContain('`thinking`');
});
test('nextEdit format and display enums match the code', () => {
  const props = settingProps;
  expect(props['aiAutocomplete.nextEdit.format'].enum).toEqual([...NEXT_EDIT_FORMATS]);
  expect(props['aiAutocomplete.nextEdit.display'].enum).toEqual([...NEXT_EDIT_DISPLAYS]);
});
test('backends entries declare use', () => {
  const use = settingProps['aiAutocomplete.backends'].items.properties.use;
  expect(use.items.enum).toEqual(['completions', 'nextEdit']);
});
test('completions.disableInFiles default matches the code and covers common credential files', () => {
  expect(settingProps['aiAutocomplete.completions.disableInFiles'].default).toEqual([...DEFAULT_DISABLE_IN_FILES]);
  for (const p of ['**/.env', '**/*.pem', '**/*.key', '**/.npmrc', '**/.pypirc', '**/*.tfvars', '**/*.p12', '**/*.pfx', '**/.netrc', '**/.docker/config.json', '**/id_rsa*', '**/id_ed25519*']) {
    expect(DEFAULT_DISABLE_IN_FILES).toContain(p);
  }
});
test('Marketplace fields', () => {
  expect(pkg.keywords).toEqual(['autocomplete', 'code completion', 'fill in the middle', 'next edit', 'llama.cpp', 'lm studio', 'ollama', 'self-hosted', 'local', 'codestral']);
  expect(pkg.homepage).toBe('https://github.com/Raboo/vscode-ai-autocomplete#readme');
  expect(pkg.bugs).toEqual({ url: 'https://github.com/Raboo/vscode-ai-autocomplete/issues' });
});
test('settings come in titled sections, each setting ordered', () => {
  const sections = pkg.contributes.configuration as { title: string; properties: Record<string, { order?: number }> }[];
  expect(sections.map((s) => s.title)).toEqual(['General', 'Completions', 'Next Edit', 'Local models', 'Advanced']);
  const keys = (title: string) => Object.keys(sections.find((s) => s.title === title)!.properties);
  expect(keys('General').sort()).toEqual(['aiAutocomplete.backends', 'aiAutocomplete.enabled', 'aiAutocomplete.privacy.localOnly']);
  expect(keys('Completions').every((k) => k.startsWith('aiAutocomplete.completions.') || k.startsWith('aiAutocomplete.fim.'))).toBe(true);
  expect(keys('Next Edit').every((k) => k.startsWith('aiAutocomplete.nextEdit.'))).toBe(true);
  expect(keys('Local models').every((k) => k.startsWith('aiAutocomplete.local.'))).toBe(true);
  expect(keys('Advanced').sort()).toEqual(['aiAutocomplete.debug.logPrompts', 'aiAutocomplete.modelOverrides']);
  for (const s of sections) {
    const orders = Object.values(s.properties).map((p) => p.order);
    expect(orders.every((o) => typeof o === 'number'), s.title).toBe(true);
    expect(new Set(orders).size, s.title).toBe(orders.length);
  }
  const order = (k: string) => settingProps[`aiAutocomplete.${k}`].order as number;
  expect(order('enabled')).toBeLessThan(order('backends'));
  expect(order('completions.enabled')).toBeLessThan(order('completions.backend'));
  expect(order('completions.backend')).toBeLessThan(order('completions.debounceMs'));
  expect(order('nextEdit.enabled')).toBeLessThan(order('nextEdit.backend'));
  expect(order('nextEdit.backend')).toBeLessThan(order('nextEdit.timeoutMs'));
});
test('setting descriptions without jargon', () => {
  expect(settingProps['aiAutocomplete.completions.enabled'].markdownDescription ?? settingProps['aiAutocomplete.completions.enabled'].description).toBe('Show inline code completions (ghost text).');
  const format = settingProps['aiAutocomplete.nextEdit.format'];
  expect(format.enumDescriptions[format.enum.indexOf('chatXtab')]).toBe('Chat prompt, for general chat models such as Qwen on Strata.');
  const display = settingProps['aiAutocomplete.nextEdit.display'];
  expect(display.markdownEnumDescriptions[display.enum.indexOf('native')]).toBe("VS Code's own inline-edit view. Needs **Enable Native Next Edit UI** and a VS Code restart.");
  expect(settingProps['aiAutocomplete.completions.backend'].default).toBe('');
  expect(settingProps['aiAutocomplete.nextEdit.backend'].default).toBe('');
});

test('machine-scoped settings stay machine-scoped (a workspace must never redirect code or paths)', () => {
  const machine = Object.entries(settingProps).filter(([, p]) => (p as { scope?: string }).scope === 'machine').map(([k]) => k).sort();
  expect(machine).toEqual([
    'aiAutocomplete.backends',
    'aiAutocomplete.debug.logPrompts',
    'aiAutocomplete.local.llamaServerPath',
    'aiAutocomplete.local.lmsPath',
    'aiAutocomplete.modelOverrides',
  ]);
});

test('fim.* is renamed to completions.*: the old keys stay registered (so they can be moved), deprecated, without defaults', () => {
  for (const k of COMPLETIONS_KEYS) {
    const now = settingProps[`aiAutocomplete.completions.${k}`];
    const old = settingProps[`aiAutocomplete.fim.${k}`];
    expect(now, k).toBeDefined();
    expect(old.markdownDeprecationMessage, k).toContain(`#aiAutocomplete.completions.${k}#`);
    expect(old.scope, k).toBe(now.scope);
    expect(old, k).not.toHaveProperty('default');
    expect(old.order, k).toBeGreaterThan(100);
  }
  const fields = Object.keys(settingProps['aiAutocomplete.backends'].items.properties);
  expect(fields).toEqual(expect.arrayContaining(['model', 'mode', 'completions', 'nextEditModel']));
  expect(fields).not.toEqual(expect.arrayContaining(['fimModel']));
  expect(fields).not.toContain('fimMode');
  expect(fields).not.toContain('fim');
  expect(JSON.stringify(pkg.contributes.configuration)).not.toMatch(/#aiAutocomplete\.fim\.|fimModel/);
});

test('the icon is a PNG and ships', () => {
  expect(pkg.icon).toBe('images/icon.png');
  expect(pkg.galleryBanner).toEqual({ color: '#0b1530', theme: 'dark' });
  expect([...readFileSync(pkg.icon).subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  expect(readFileSync('.vscodeignore', 'utf8')).toMatch(/^!images\/\*\*$/m);
});

test('the Get started walkthrough: media exists and ships, command links name real commands', () => {
  const [w] = pkg.contributes.walkthroughs;
  expect(w.id).toBe('getStarted');
  expect(w.steps.length).toBeGreaterThanOrEqual(4);
  const ignore = readFileSync('.vscodeignore', 'utf8');
  const own = new Set((pkg.contributes.commands as { command: string }[]).map((c) => c.command));
  const workbench = new Set(['workbench.action.openSettings']);
  for (const step of w.steps) {
    const media = step.media.image ?? step.media.markdown;
    expect(existsSync(media), step.id).toBe(true);
    expect(ignore, step.id).toContain(`!${media.split('/')[0]}/**`);
    for (const m of (step.description as string).matchAll(/\(command:([^)?]+)/g)) expect(own.has(m[1]) || workbench.has(m[1]), `${step.id}: ${m[1]}`).toBe(true);
    for (const e of (step.completionEvents ?? []) as string[]) expect(own.has(e.replace('onCommand:', '')), e).toBe(true);
  }
});
