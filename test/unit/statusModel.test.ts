import { describe, expect, test } from 'vitest';
import { activity, displayState, hhmm, menuEntries, menuGroups, menuInputs, noCompletionBackend, stateName, tooltipLines, type MenuInputs } from '../../src/ui/statusModel';
import { memoizeIsLocal } from '../../src/config/localOnly';

describe('displayState', () => {
  const last = { state: 'error', detail: 'boom' } as const;
  test('disabled beats snoozed and last', () => {
    expect(displayState(false, 1000, 0, last)).toEqual({ state: 'disabled' });
  });
  test('snoozed beats last while now < snoozedUntil', () => {
    expect(displayState(true, 1000, 999, last)).toEqual({ state: 'snoozed' });
  });
  test('last state once the snooze has expired (boundary included)', () => {
    expect(displayState(true, 1000, 1000, last)).toBe(last);
    expect(displayState(true, 0, 5, { state: 'idle' })).toEqual({ state: 'idle' });
  });
  test('re-enabled → last outcome shown', () => {
    const outcome = { state: 'error', detail: 'local: HTTP 503' } as const;
    expect(displayState(false, 0, 5, outcome)).toEqual({ state: 'disabled' });
    expect(displayState(true, 0, 5, outcome)).toBe(outcome);
    expect(displayState(true, 4, 5, { state: 'idle' })).toEqual({ state: 'idle' });
  });
  test('until-restart snooze stays snoozed', () => {
    expect(displayState(true, Number.MAX_SAFE_INTEGER, Date.now(), last).state).toBe('snoozed');
  });
});

describe('menuEntries', () => {
  const M = (patch: Partial<MenuInputs> = {}): MenuInputs => ({ backendCount: 1, enabled: true, nativeNextEdit: false, ...patch });
  const ids = (state: Parameters<typeof menuEntries>[0], count = 1, native = false) => menuEntries(state, M({ backendCount: count, nativeNextEdit: native })).map((e) => e.id);
  const BACKENDS = ['selectBackend', 'selectNextEditBackend'];
  const PAUSE = ['toggleEnabled', 'snooze'];
  test('lists Retry now first while the status is error', () => {
    expect(menuEntries('error', M())[0]).toEqual({ label: 'Retry now', id: 'retry' });
    expect(ids('error').filter((id) => id === 'retry')).toHaveLength(1);
  });
  test('lists Resume now first while snoozed', () => {
    expect(menuEntries('snoozed', M())[0]).toEqual({ label: 'Resume now', id: 'resume' });
    expect(ids('snoozed').slice(1)).toEqual(ids('idle'));
    expect(ids('idle')).not.toContain('resume');
    expect(ids('error')).not.toContain('resume');
  });
  test('lists Retry now after the setup entries otherwise', () => {
    expect(ids('idle')).toEqual([...BACKENDS, 'manageBackends', 'setUpLocalModel', 'enableNativeNextEdit', ...PAUSE, 'openSettings', 'setApiKey', 'retry', 'showLog', 'whyNoSuggestion', 'about']);
    expect(ids('loading')).toEqual(ids('idle'));
  });
  test('no separate completions toggle: the Completions entry turns them off', () => {
    expect(ids('idle')).not.toContain('toggle');
  });
  test('the native UI entry is absent once the native UI is on; Settings stays', () => {
    expect(ids('idle', 1, true)).toEqual([...BACKENDS, 'manageBackends', 'setUpLocalModel', ...PAUSE, 'openSettings', 'setApiKey', 'retry', 'showLog', 'whyNoSuggestion', 'about']);
    expect(menuEntries('idle', M()).find((e) => e.id === 'enableNativeNextEdit')).toEqual({ label: 'Enable native Next Edit UI...', id: 'enableNativeNextEdit' });
    expect(menuEntries('idle', M()).find((e) => e.id === 'openSettings')).toEqual({ label: 'Settings...', id: 'openSettings' });
  });
  test('the menu shows the Next Edit backend or off', () => {
    const label = (id: string | undefined) => menuEntries('idle', M({ nextEditBackend: id })).find((e) => e.id === 'selectNextEditBackend')?.label;
    expect(label('mercury')).toBe('Next Edit: mercury');
    expect(label(undefined)).toBe('Next Edit: off');
  });
  test('the menu shows the completion backend or off', () => {
    const label = (id: string | undefined) => menuEntries('idle', M({ completionBackend: id })).find((e) => e.id === 'selectBackend')?.label;
    expect(label('coder')).toBe('Completions: coder');
    expect(label(undefined)).toBe('Completions: off');
  });
  test('the switch says what it will do', () => {
    expect(menuEntries('idle', M()).find((e) => e.id === 'toggleEnabled')).toEqual({ label: 'Turn off AI Autocomplete', id: 'toggleEnabled' });
    expect(menuEntries('disabled', M({ enabled: false })).find((e) => e.id === 'toggleEnabled')).toEqual({ label: 'Turn on AI Autocomplete', id: 'toggleEnabled' });
  });
  test('Set up local model comes right after Manage backends', () => {
    // With no backend, both lead the menu; otherwise they follow the backend pickers.
    expect(menuEntries('idle', M()).find((e) => e.id === 'setUpLocalModel')).toEqual({ label: 'Set up local model...', id: 'setUpLocalModel' });
    for (const count of [0, 1]) {
      for (const state of ['idle', 'error', 'snoozed'] as const) {
        const list = ids(state, count);
        expect(list.indexOf('setUpLocalModel')).toBe(list.indexOf('manageBackends') + 1);
      }
    }
  });
  test('Manage backends and Set up local model come first when no backend exists', () => {
    expect(menuEntries('idle', M({ backendCount: 0 }))[0]).toEqual({ label: 'Manage backends...', id: 'manageBackends' });
    expect(ids('idle', 0)).toEqual(['manageBackends', 'setUpLocalModel', ...BACKENDS, 'enableNativeNextEdit', ...PAUSE, 'openSettings', 'setApiKey', 'retry', 'showLog', 'whyNoSuggestion', 'about']);
    expect(ids('error', 0).slice(0, 3)).toEqual(['manageBackends', 'setUpLocalModel', 'retry']);
    expect(ids('snoozed', 0).slice(0, 3)).toEqual(['manageBackends', 'setUpLocalModel', 'resume']);
    for (const state of ['idle', 'error', 'snoozed'] as const) {
      expect(ids(state, 0).filter((id) => id === 'manageBackends')).toHaveLength(1);
      expect(ids(state, 0).filter((id) => id === 'setUpLocalModel')).toHaveLength(1);
    }
  });
});

describe('menuInputs', () => {
  const S = (patch: { enabled?: boolean; fim?: { enabled: boolean; backendId?: string }; nextEdit?: { enabled: boolean; backendId?: string } } = {}) => ({
    enabled: true, backends: [{}, {}], fim: { enabled: true, backendId: 'coder' }, nextEdit: { enabled: true, backendId: 'strata' }, ...patch,
  });
  test('names both backends', () => {
    expect(menuInputs(S(), false)).toEqual({ backendCount: 2, enabled: true, completionBackend: 'coder', nextEditBackend: 'strata', nativeNextEdit: false });
  });
  test('the entries keep naming their backends while the switch is off', () => {
    expect(menuInputs(S({ enabled: false }), true)).toMatchObject({ enabled: false, completionBackend: 'coder', nextEditBackend: 'strata', nativeNextEdit: true });
  });
  test('a feature turned off shows off; its backend is kept in the settings, not in the label', () => {
    const m = menuInputs(S({ fim: { enabled: false, backendId: 'coder' }, nextEdit: { enabled: false, backendId: 'strata' } }), false);
    expect(m.completionBackend).toBeUndefined();
    expect(m.nextEditBackend).toBeUndefined();
  });
  test('completions on without a backend read none; Next Edit without one is off', () => {
    const m = menuInputs(S({ fim: { enabled: true }, nextEdit: { enabled: true } }), false);
    expect(m.completionBackend).toBe('none');
    expect(m.nextEditBackend).toBeUndefined();
    expect(menuEntries('idle', m).find((e) => e.id === 'selectBackend')?.label).toBe('Completions: none');
  });
});

describe('activity', () => {
  const S = (enabled: boolean, fim: boolean, nextEdit: boolean, backendId: string | null = 'ne') => ({ enabled, fim: { enabled: fim }, nextEdit: { enabled: nextEdit, ...(backendId !== null ? { backendId } : {}) } });
  test('on with completions on; no note', () => {
    expect(activity(S(true, true, false))).toEqual({ on: true });
    expect(activity(S(true, true, true))).toEqual({ on: true });
  });
  test('completions off with Next Edit running stays on and says so', () => {
    expect(activity(S(true, false, true))).toEqual({ on: true });
  });
  test('off when neither runs: completions off and Next Edit off, disabled or without a backend', () => {
    expect(activity(S(true, false, false))).toEqual({ on: false });
    expect(activity(S(true, false, true, null))).toEqual({ on: false });
  });
  test('the switch turns both off', () => {
    expect(activity(S(false, true, true))).toEqual({ on: false });
  });
});

describe('memoizeIsLocal', () => {
  test('calls once per baseUrl within the ttl, again after, and after clear()', async () => {
    let t = 0;
    let calls = 0;
    const m = memoizeIsLocal(async (u) => { calls++; return u.includes('local'); }, 60_000, () => t);
    expect(await m('http://local')).toBe(true);
    expect(await m('http://local')).toBe(true);
    expect(await m('http://remote')).toBe(false);
    expect(calls).toBe(2);
    t = 59_999;
    await m('http://local');
    expect(calls).toBe(2);
    t = 60_000;
    await m('http://local');
    expect(calls).toBe(3);
    m.clear();
    await m('http://local');
    expect(calls).toBe(4);
  });
});

describe('noCompletionBackend', () => {
  test('no backend at all is an error, as before', () => {
    expect(noCompletionBackend(0)).toEqual({ state: 'error', detail: 'No backend configured' });
  });
  test('backends that none serves completions leave the status idle, so the menu has no Retry first', () => {
    const { state, detail } = noCompletionBackend(2);
    expect(state).toBe('idle');
    expect(detail).toBe('No backend is used for completions');
    expect(menuEntries(state, { backendCount: 2, enabled: true, nextEditBackend: 'zeta', nativeNextEdit: false })[0].id).toBe('selectBackend');
  });
});

describe('tooltip', () => {
  const M = (patch: Partial<MenuInputs> = {}): MenuInputs => ({ backendCount: 1, enabled: true, nativeNextEdit: false, completionBackend: 'coder', nextEditBackend: 'zeta', ...patch });
  const at = new Date(2026, 10, 18, 9, 5).getTime();
  test('friendly state names', () => {
    expect(stateName('idle', 0)).toBe('Ready');
    expect(stateName('loading', 0)).toBe('Requesting…');
    expect(stateName('error', 0)).toBe('Error');
    expect(stateName('disabled', 0)).toBe('Turned off');
    expect(stateName('snoozed', Number.MAX_SAFE_INTEGER)).toBe('Snoozed');
    expect(stateName('snoozed', at)).toBe('Snoozed until 09:05');
    expect(hhmm(new Date(2026, 0, 1, 23, 59).getTime())).toBe('23:59');
  });
  test('lists the state, its detail, both backends, local-only and the session counts', () => {
    expect(tooltipLines({ shown: { state: 'error', detail: 'coder: HTTP 503' }, snoozedUntil: 0, locked: true, session: { requests: 42, shown: 17, accepted: 3, medianMs: 380 }, menu: M() })).toEqual([
      'AI Autocomplete: Error',
      'coder: HTTP 503',
      'Completions: coder',
      'Next Edit: zeta',
      'Local only: requests go to loopback or private-network hosts only',
      'This session: 42 requests · 17 shown · 3 accepted · median 380 ms',
    ]);
  });
  test('a feature without a backend reads off', () => {
    expect(tooltipLines({ shown: { state: 'idle' }, snoozedUntil: 0, locked: false, session: { requests: 0, shown: 0, accepted: 0 }, menu: M({ completionBackend: undefined, nextEditBackend: undefined }) })).toEqual([
      'AI Autocomplete: Ready',
      'Completions: off',
      'Next Edit: off',
      'This session: 0 requests · 0 shown · 0 accepted',
    ]);
  });
  test('a snooze with an end time names it', () => {
    expect(tooltipLines({ shown: { state: 'snoozed' }, snoozedUntil: at, locked: false, session: { requests: 0, shown: 0, accepted: 0 }, menu: M() })[0]).toBe('AI Autocomplete: Snoozed until 09:05');
  });
});

describe('menuGroups', () => {
  const M = (patch: Partial<MenuInputs> = {}): MenuInputs => ({ backendCount: 1, enabled: true, nativeNextEdit: false, ...patch });
  const shape = (state: Parameters<typeof menuEntries>[0], m = M()) => menuGroups(menuEntries(state, m)).map((g) => [g.title, g.entries.map((e) => e.id)]);
  test('groups the entries under Backends, Pause and Help, keeping their order', () => {
    expect(shape('idle')).toEqual([
      ['Backends', ['selectBackend', 'selectNextEditBackend', 'manageBackends', 'setUpLocalModel', 'enableNativeNextEdit']],
      ['Pause', ['toggleEnabled', 'snooze']],
      ['Help', ['openSettings', 'setApiKey', 'retry', 'showLog', 'whyNoSuggestion', 'about']],
    ]);
  });
  test('Retry and Resume stay first, above every group', () => {
    expect(shape('error')[0]).toEqual([undefined, ['retry']]);
    expect(shape('snoozed')[0]).toEqual([undefined, ['resume']]);
    expect(shape('error').flatMap(([, ids]) => ids).filter((id) => id === 'retry')).toHaveLength(1);
  });
  test('with no backend, Manage backends and Set up local model come first', () => {
    expect(shape('idle', M({ backendCount: 0 }))[0]).toEqual([undefined, ['manageBackends', 'setUpLocalModel']]);
    expect(shape('error', M({ backendCount: 0 })).slice(0, 2)).toEqual([[undefined, ['manageBackends', 'setUpLocalModel']], [undefined, ['retry']]]);
  });
  test('no entry is lost or doubled', () => {
    for (const state of ['idle', 'error', 'snoozed'] as const) {
      for (const count of [0, 1]) {
        const flat = menuGroups(menuEntries(state, M({ backendCount: count }))).flatMap((g) => g.entries.map((e) => e.id));
        expect(flat.sort()).toEqual(ids(state, count).sort());
      }
    }
  });
  const ids = (state: Parameters<typeof menuEntries>[0], count: number) => menuEntries(state, M({ backendCount: count })).map((e) => e.id);
});
