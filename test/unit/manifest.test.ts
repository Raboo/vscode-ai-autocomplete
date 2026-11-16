import { expect, test } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { FIM_LIMITS, NEXT_EDIT_DISPLAYS, NEXT_EDIT_FORMATS, THINKING_STRATEGIES } from '../../src/config/settings';
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
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
    ['about', 'accepted', 'enableNativeNextEdit', 'manageBackends', 'menu', 'nextEditAccepted', 'nextEditDismiss', 'nextEditTab', 'openSettings', 'retry', 'selectBackend', 'selectNextEditBackend', 'setApiKey', 'showLog', 'snooze', 'toggle', 'toggleEnabled']
      .map((c) => `aiAutocomplete.${c}`)
      .sort(),
  );
  expect(cmds.every((c) => c.category === 'AI Autocomplete')).toBe(true);
  for (const id of ['accepted', 'nextEditAccepted', 'nextEditTab', 'nextEditDismiss']) {
    expect(pkg.contributes.menus.commandPalette).toContainEqual({ command: `aiAutocomplete.${id}`, when: 'false' });
  }
  expect(pkg.contributes.menus.commandPalette).not.toContainEqual({ command: 'aiAutocomplete.openSettings', when: 'false' });
  expect((pkg.contributes.commands as { command: string; title: string }[]).find((c) => c.command === 'aiAutocomplete.openSettings')?.title).toBe('Open Settings');
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
  const backends = pkg.contributes.configuration.properties['aiAutocomplete.backends'];
  expect(backends.markdownDescription.startsWith('[Manage backends](command:aiAutocomplete.manageBackends)')).toBe(true);
  const manage = (pkg.contributes.commands as { command: string; title: string }[]).find((c) => c.command === 'aiAutocomplete.manageBackends');
  expect(manage?.title).toBe('Manage Backends');
});
test('backends schema fim limits match FIM_LIMITS', () => {
  const props = pkg.contributes.configuration.properties['aiAutocomplete.backends'].items.properties.fim.properties;
  for (const [key, lim] of Object.entries(FIM_LIMITS)) {
    const p = props[key];
    expect(p, key).toBeDefined();
    if (lim.exclusiveMin) { expect(p.exclusiveMinimum, key).toBe(lim.min); expect(p.minimum, key).toBeUndefined(); } else expect(p.minimum, key).toBe(lim.min);
    expect(p.maximum, key).toBe(lim.max);
    expect(p.type === 'integer', key).toBe(lim.integer);
  }
});
test('fim.thinking schema enum equals THINKING_STRATEGIES; modelOverrides description names thinking', () => {
  const props = pkg.contributes.configuration.properties;
  expect(props['aiAutocomplete.backends'].items.properties.fim.properties.thinking.enum).toEqual([...THINKING_STRATEGIES]);
  expect(props['aiAutocomplete.modelOverrides'].markdownDescription).toContain('`thinking`');
});
test('nextEdit format and display enums match the code', () => {
  const props = pkg.contributes.configuration.properties;
  expect(props['aiAutocomplete.nextEdit.format'].enum).toEqual([...NEXT_EDIT_FORMATS]);
  expect(props['aiAutocomplete.nextEdit.display'].enum).toEqual([...NEXT_EDIT_DISPLAYS]);
});
test('backends entries declare use', () => {
  const use = pkg.contributes.configuration.properties['aiAutocomplete.backends'].items.properties.use;
  expect(use.items.enum).toEqual(['completions', 'nextEdit']);
});
