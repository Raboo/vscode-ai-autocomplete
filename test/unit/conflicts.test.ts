import { describe, expect, it } from 'vitest';
import { activeConflicts, CONFLICTS } from '../../src/config/conflicts';

const none = (): unknown => undefined;

describe('activeConflicts', () => {
  it('lists an installed extension whose inline suggestions are on', () => {
    const r = activeConflicts([{ id: 'GitHub.copilot' }], none, new Set());
    expect(r).toEqual([{ id: 'github.copilot', name: 'GitHub Copilot' }]);
  });

  it('ignores extensions that are not in the table', () => {
    expect(activeConflicts([{ id: 'some.other' }], none, new Set())).toEqual([]);
  });

  it('skips an extension whose own setting turns suggestions off', () => {
    const get = (k: string): unknown => ({ 'github.copilot.enable': { '*': false } })[k];
    expect(activeConflicts([{ id: 'github.copilot' }], get, new Set())).toEqual([]);
    const get2 = (k: string): unknown => ({ 'continue.enableTabAutocomplete': false })[k];
    expect(activeConflicts([{ id: 'continue.continue' }], get2, new Set())).toEqual([]);
  });

  it('keeps an extension whose setting is on, unset or malformed', () => {
    const get = (k: string): unknown => ({ 'github.copilot.enable': { '*': true } })[k];
    expect(activeConflicts([{ id: 'github.copilot' }], get, new Set())).toHaveLength(1);
    const bad = (): unknown => 'nope';
    expect(activeConflicts([{ id: 'github.copilot' }], bad, new Set())).toHaveLength(1);
  });

  it('skips dismissed ids', () => {
    expect(activeConflicts([{ id: 'github.copilot' }], none, new Set(['github.copilot']))).toEqual([]);
  });

  it('treats an extension without a known setting as active', () => {
    expect(activeConflicts([{ id: 'TabNine.tabnine-vscode' }], none, new Set())).toHaveLength(1);
  });

  it('covers the six known extensions with lowercase ids', () => {
    expect(CONFLICTS.map((c) => c.id).sort()).toEqual([
      'codeium.codeium', 'continue.continue', 'github.copilot', 'kilocode.kilo-code', 'supermaven.supermaven', 'tabnine.tabnine-vscode',
    ]);
  });
});
