import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { configure, unconfigure, waitFor } from './helpers';

/** Every setting a test may write; teardown resets them so tests stay independent. */
const TOUCHED = ['backends', 'fim.enabled', 'completions.enabled'];

suite('old setting names', () => {
  const cfg = () => vscode.workspace.getConfiguration('aiAutocomplete');

  suiteSetup(async () => {
    await vscode.extensions.getExtension('raboo.ai-autocomplete')!.activate();
  });

  teardown(async () => {
    await unconfigure(TOUCHED);
  });

  test('an old fim.enabled and a backend with fimModel in user settings are moved to the new names', async () => {
    await configure({ backends: [{ id: 'old', kind: 'llamacpp', baseUrl: 'http://127.0.0.1:9', fimModel: 'coder', fimMode: 'native' }], 'fim.enabled': false });
    const moved = await waitFor(() => cfg().inspect('fim.enabled')?.globalValue === undefined && cfg().inspect('completions.enabled')?.globalValue === false, 5000);
    assert.ok(moved, `fim.enabled was not moved: ${JSON.stringify({ old: cfg().inspect('fim.enabled'), now: cfg().inspect('completions.enabled') })}`);
    const backendsMoved = await waitFor(() => JSON.stringify(cfg().inspect('backends')?.globalValue).includes('"model"'), 5000);
    assert.ok(backendsMoved, 'the backend entry was not rewritten');
    assert.deepEqual(cfg().inspect('backends')?.globalValue, [{ id: 'old', kind: 'llamacpp', baseUrl: 'http://127.0.0.1:9', model: 'coder', mode: 'native' }]);
  });
});
