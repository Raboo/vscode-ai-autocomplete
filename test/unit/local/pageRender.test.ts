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

  test('Use for offers only the uses the model supports', () => {
    const at = (uses: ModelRow['uses']): string => only(renderPage(state({}, [row({ download: { kind: 'done' }, uses })])), 'm1');
    expect(at(['completions'])).toContain('data-uses="completions"');
    expect(at(['completions'])).not.toContain('data-uses="nextEdit"');
    expect(at(['completions'])).not.toContain('completions,nextEdit');
    expect(at(['completions', 'nextEdit'])).toContain('completions,nextEdit');
  });

  test('swap warning text is exact and absent when off', () => {
    const on = renderPage(state({ server: { state: 'stopped', modelsInMemory: 1, log: [], swapWarning: true } }));
    expect(on).toContain('Completions and Next Edit use different models; with 1 model in memory the server swaps between them (seconds each). Use one model for both, or set Models in memory to 2.');
    expect(renderPage(state())).not.toContain('use different models');
  });

  test('override note shows only when another override matches', () => {
    const form = (otherOverridesMatch: boolean) => renderPage(state({ form: { name: 'm1', contextTokens: 1, extraArgs: '', sampling: {}, otherOverridesMatch } }));
    expect(form(true)).toContain('other overrides also match this model');
    expect(form(false)).not.toContain('other overrides also match this model');
  });

  test('a picked file and its name survive a render', () => {
    const html = renderPage(state({ add: { repo: 'o/r', files: [{ path: 'a.gguf', bytes: 1, supported: true }, { path: 'b.gguf', bytes: 1, supported: true }], picked: 'b.gguf', name: 'b', uses: ['nextEdit'], contextTokens: 4096 } }));
    expect(html).toMatch(/value="b\.gguf" checked/);
    expect(html).not.toMatch(/value="a\.gguf"[^>]*checked/);
    expect(html).toContain('value="b"');
    expect(html).toContain('value="4096"');
    expect(html).toMatch(/class="add-use" value="nextEdit" checked/);
    expect(html).not.toMatch(/class="add-use" value="completions" checked/);
  });

  test('the default offer is one button that sets it up, disabled while it runs', () => {
    const html = renderPage(state({ offer: { name: 'sweep', label: 'Sweep <1.5B>', bytes: 2 ** 30, busy: false } }));
    expect(html).toContain('data-action="setUpDefault"');
    expect(html).toContain('Sweep &lt;1.5B&gt;');
    expect(renderPage(state({ offer: { name: 'sweep', label: 'S', bytes: 1, busy: true } }))).toMatch(/data-action="setUpDefault"[^>]* disabled/);
    expect(renderPage(state())).not.toContain('setUpDefault');
  });

  test('Hugging Face access errors link to the repo page; other links are never rendered', () => {
    const link = 'https://huggingface.co/o/r';
    const add = renderPage(state({ add: { repo: 'o/r', error: 'needs a token', link } }));
    expect(add).toContain(`<a href="${link}">`);
    const dl = only(renderPage(state({}, [row({ download: { kind: 'failed', error: 'x', link } })])), 'm1');
    expect(dl).toContain(`<a href="${link}">`);
    const up = only(renderPage(state({}, [row({ builtIn: false, update: { error: 'needs a token', link } })])), 'm1');
    expect(up).toContain('needs a token');
    expect(up).toContain(`<a href="${link}">`);
    const bad = renderPage(state({ add: { repo: 'o/r', error: 'x', link: 'javascript:alert(1)' } }));
    expect(bad).not.toContain('javascript:');
  });

  test('no block element inside a paragraph, no token in the page', () => {
    const html = renderPage(state({ settings: { modelsDir: '/m', tokenSet: true } }, []));
    expect(html).not.toMatch(/<p class="line"><div/);
    expect(html).toContain('token: set');
  });
});

