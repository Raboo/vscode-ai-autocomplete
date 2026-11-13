import { describe, expect, test } from 'vitest';
import { displayState, menuEntries } from '../../src/ui/statusModel';
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
  test('until-restart snooze stays snoozed', () => {
    expect(displayState(true, Number.MAX_SAFE_INTEGER, Date.now(), last).state).toBe('snoozed');
  });
});

describe('menuEntries', () => {
  const ids = (state: Parameters<typeof menuEntries>[0]) => menuEntries(state).map((e) => e.id);
  test('lists Retry now first while the status is error', () => {
    expect(menuEntries('error')[0]).toEqual({ label: 'Retry now', id: 'retry' });
    expect(ids('error').filter((id) => id === 'retry')).toHaveLength(1);
  });
  test('lists Retry now after the setup entries otherwise', () => {
    expect(ids('idle')).toEqual(['toggle', 'snooze', 'selectBackend', 'setApiKey', 'retry', 'showLog', 'about']);
    expect(ids('loading')).toEqual(ids('idle'));
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
