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

  test('an old fim.enabled in user settings is moved to the new name; a backend with fimModel is left as written', async () => {
    const backends = [{ id: 'old', kind: 'llamacpp', baseUrl: 'http://127.0.0.1:9', fimModel: 'coder', fimMode: 'native' }];
    await configure({ backends, 'fim.enabled': false });
    const moved = await waitFor(() => cfg().inspect('fim.enabled')?.globalValue === undefined && cfg().inspect('completions.enabled')?.globalValue === false, 5000);
    assert.ok(moved, `fim.enabled was not moved: ${JSON.stringify({ old: cfg().inspect('fim.enabled'), now: cfg().inspect('completions.enabled') })}`);
    assert.deepEqual(cfg().inspect('backends')?.globalValue, backends);
  });
});
