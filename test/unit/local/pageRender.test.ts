import { describe, expect, test } from 'vitest';
import type { LocalPageState, ModelRow } from '../../../src/local/page/protocol';
import { renderPage } from '../../../src/webview/localModels/render';

const row = (over: Partial<ModelRow> = {}): ModelRow => ({
  name: 'm1', label: 'Model one', bytes: 2 ** 30, uses: ['completions'], builtIn: true, hidden: false, download: { kind: 'none' },
  load: 'n/a', usedFor: [], mayNotFit: false, ...over,
});
const state = (over: Partial<LocalPageState> = {}, models: ModelRow[] = [row()]): LocalPageState => ({
  server: { state: 'stopped', modelsInMemory: 1, log: [], swapWarning: false }, settings: { modelsDir: '/m', tokenSet: false }, problems: [], models, ...over,
});
const only = (html: string, name: string): string => {
  const i = html.indexOf(`data-model="${name}"`);
  expect(i).toBeGreaterThanOrEqual(0);
  const j = html.indexOf('data-model="', i + 1);
  return html.slice(i, j < 0 ? undefined : j);
};

describe('local models page render', () => {
  test('escapes server and user supplied text', () => {
    const html = renderPage(state({
      server: { state: 'failed', modelsInMemory: 1, log: ['<script>x</script>'], swapWarning: false, hint: '<b>h</b>', binary: '<i>' },
      problems: ['<u>p</u>'],
      form: { name: '<img src=x>', contextTokens: 1, extraArgs: '"><x>', sampling: {}, otherOverridesMatch: true, error: '<e>' },
      add: { repo: '<r>', files: [{ path: '<f>.gguf', bytes: 1, supported: false, reason: '<why>' }] },
    }, [row({ name: '<img src=x>', label: '<b>L</b>', download: { kind: 'failed', error: '<err>' } })]));
    for (const raw of ['<img', '<script>', '<b>', '<i>', '<u>', '<e>', '<r>', '<f>', '<why>', '<err>', '"><x>']) expect(html).not.toContain(raw);
    expect(html).toContain('&lt;img src=x&gt;');
    expect(html).toContain('&lt;script&gt;x&lt;/script&gt;');
  });

  test('download buttons follow the download kind', () => {
    const at = (kind: ModelRow['download']['kind']): string => only(renderPage(state({}, [row({ download: { kind } })])), 'm1');
    expect(at('none')).toContain('data-action="download"');
    expect(at('none')).not.toContain('data-action="cancelDownload"');
    expect(at('running')).toContain('data-action="cancelDownload"');
    expect(at('running')).not.toContain('data-action="download"');
    expect(at('done')).toContain('data-action="removeFile"');
    expect(at('failed')).toContain('data-action="download"');
  });

  test('Load and Unload only while the router runs', () => {
    const at = (load: ModelRow['load']): string => only(renderPage(state({}, [row({ download: { kind: 'done' }, load })])), 'm1');
    expect(at('n/a')).not.toMatch(/data-action="(un)?load"/);
    expect(at('unloaded')).toContain('data-action="load"');
    expect(at('loaded')).toContain('data-action="unload"');
    expect(at('sleeping')).toContain('sleeping');
  });

  test('update and removal buttons depend on built-in or added', () => {
    const added = only(renderPage(state({}, [row({ builtIn: false })])), 'm1');
    const built = only(renderPage(state({}, [row({ builtIn: true })])), 'm1');
    expect(added).toContain('data-action="checkUpdate"');
    expect(added).toContain('data-action="removeModel"');
    expect(added).not.toContain('data-action="hide"');
    expect(built).not.toContain('data-action="checkUpdate"');
    expect(built).not.toContain('data-action="removeModel"');
    expect(built).toContain('data-action="hide"');
    expect(only(renderPage(state({}, [row({ hidden: true })])), 'm1')).toContain('data-action="unhide"');
  });

  test('server section: warnings, note, token never shown', () => {
    const html = renderPage(state({ server: { state: 'running', port: 8012, modelsInMemory: 1, log: ['l1'], swapWarning: true, memoryWarning: 'mem' } }));
    expect(html).toContain('different models');
    expect(html).toContain('mem');
    expect(html).toContain('Changing this restarts the server from this window.');
    expect(html).toContain('8012');
    expect(html).toContain('data-action="stop"');
    expect(html).toContain('l1');
  });

  test('add flow lists files and disables unsupported ones with the reason', () => {
    const html = renderPage(state({ add: { repo: 'o/r', files: [
      { path: 'ok.gguf', bytes: 5 * 2 ** 20, supported: true },
      { path: 'big-00001-of-00002.gguf', bytes: 1, supported: false, reason: 'multi-file models are not supported' },
    ] } }));
    expect(html).toContain('multi-file models are not supported');
    expect(html).toMatch(/value="big-00001-of-00002\.gguf"[^>]*disabled/);
    expect(html).not.toMatch(/value="ok\.gguf"[^>]*disabled/);
    expect(html).toContain('data-action="addFile"');
  });
});
