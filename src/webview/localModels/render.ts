// Markup of the Local Models page. Pure string building: no DOM types, so vitest runs it under node.
// Every string taken from the state goes through escapeHtml, in text and in (always double-quoted) attributes.
// The page CSP allows no inline styles or handlers: the markup uses classes, and main.ts delegates on data-action.
import type { BackendUse } from '../../config/settings';
import type { AddState, LocalPageState, ModelForm, ModelRow, UpdateView } from '../../local/page/protocol';

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export function escapeHtml(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) => ESCAPES[c]!);
}
const e = escapeHtml;

interface ButtonOpts { cls?: string; disabled?: boolean; extra?: string }
function button(action: string, label: string, name?: string, o: ButtonOpts = {}): string {
  return `<button type="button" class="${o.cls ?? 'btn secondary'}" data-action="${e(action)}"${name !== undefined ? ` data-name="${e(name)}"` : ''}${o.extra ?? ''}${o.disabled ? ' disabled' : ''}>${e(label)}</button>`;
}

export function formatBytes(n: number): string {
  if (n >= 2 ** 30) return `${(n / 2 ** 30).toFixed(1)} GB`;
  if (n >= 2 ** 20) return `${Math.round(n / 2 ** 20)} MB`;
  return `${Math.max(0, Math.round(n / 2 ** 10))} KB`;
}

const USE_LABEL: Record<BackendUse, string> = { completions: 'Completions', nextEdit: 'Next Edit' };
const useList = (uses: BackendUse[]): string => uses.map((u) => USE_LABEL[u]).join(', ');
const STATE_LABEL = { stopped: 'Stopped', starting: 'Starting', running: 'Running', failed: 'Failed' } as const;

function server(s: LocalPageState): string {
  const v = s.server;
  const status = v.state === 'running' && v.port !== undefined ? `Running on port ${v.port}` : STATE_LABEL[v.state];
  const actions = v.state === 'running' || v.state === 'starting'
    ? button('stop', 'Stop') + button('restart', 'Restart')
    : button('start', 'Start', undefined, { cls: 'btn primary' });
  const log = v.log.length > 0
    ? `<details class="log" id="server-log"><summary>Server log (${v.log.length} lines)</summary><pre>${v.log.map(e).join('\n')}</pre>${button('openLog', 'Open full log')}</details>` : '';
  return `<section class="section" aria-labelledby="h-server"><h2 id="h-server">Server</h2>`
    + `<p class="line"><span class="status ${e(v.state)}">${e(status)}</span>${actions}</p>`
    + `<p class="muted">${v.binary !== undefined ? `llama-server: ${e(v.binary)}${v.version !== undefined ? ` (${e(v.version)})` : ''}` : 'llama-server not found'}</p>`
    + (v.hint ? `<p class="card-warning warn">${e(v.hint)}</p>` : '')
    + `<p class="line"><label for="models-in-memory">Models in memory</label>`
    + `<input id="models-in-memory" type="number" min="1" step="1" value="${e(String(v.modelsInMemory))}">${button('setModelsInMemory', 'Apply')}</p>`
    + `<p class="hint">Changing this restarts the server from this window.</p>`
    + (v.swapWarning ? `<p class="card-warning warn">Completions and Next Edit use different models; with 1 model in memory the server swaps between them (seconds each). Use one model for both, or set Models in memory to 2.</p>` : '')
    + (v.memoryWarning ? `<p class="card-warning warn">${e(v.memoryWarning)}</p>` : '')
    + log + `</section>`;
}

function updateText(u: UpdateView | undefined): string {
  if (u === undefined) return '';
  if (u === 'checking') return 'Checking for an update...';
  if (u === 'upToDate') return 'Up to date';
  if (u === 'gone') return 'The file is no longer in the repo';
  return `Update available (${formatBytes(u.available.bytes)}${u.available.date ? `, ${u.available.date}` : ''})`;
}

/** Use for... only offers what the model supports. */
function useButtons(m: ModelRow): string[] {
  const c = m.uses.includes('completions');
  const n = m.uses.includes('nextEdit');
  return [
    ...(c ? [button('use', 'Use for completions', m.name, { extra: ' data-uses="completions"' })] : []),
    ...(n ? [button('use', 'Use for Next Edit', m.name, { extra: ' data-uses="nextEdit"' })] : []),
    ...(c && n ? [button('use', 'Use for both', m.name, { extra: ' data-uses="completions,nextEdit"' })] : []),
  ];
}

function modelRow(m: ModelRow): string {
  const d = m.download;
  const progress = d.kind === 'running' ? `Downloading ${formatBytes(d.received ?? 0)} of ${formatBytes(m.bytes)}`
    : d.kind === 'done' ? 'Downloaded' : d.kind === 'failed' ? `Download failed${d.error ? `: ${d.error}` : ''}` : 'Not downloaded';
  const loadText = m.load === 'n/a' ? '' : m.load === 'sleeping' ? 'sleeping' : m.load;
  const buttons = [
    ...(d.kind === 'running' ? [button('cancelDownload', 'Cancel', m.name)]
      : d.kind === 'done' ? [button('removeFile', 'Remove file', m.name)]
        : [button('download', d.kind === 'failed' ? 'Retry download' : 'Download', m.name)]),
    ...(d.kind === 'done' && m.load !== 'n/a' ? [m.load === 'loaded' || m.load === 'sleeping' ? button('unload', 'Unload', m.name) : button('load', 'Load', m.name, { disabled: m.load === 'loading' })] : []),
    ...(d.kind === 'done' ? useButtons(m) : []),
    button('edit', 'Edit', m.name),
    ...(m.builtIn ? [m.hidden ? button('unhide', 'Unhide', m.name) : button('hide', 'Hide', m.name)]
      : [button('checkUpdate', 'Check for update', m.name), button('removeModel', 'Remove from list', m.name, { cls: 'btn link danger' })]),
    ...(typeof m.update === 'object' ? [button('update', 'Update', m.name, { cls: 'btn primary' })] : []),
  ];
  const tags = [...(m.usedFor.length > 0 ? [`In use for ${useList(m.usedFor)}`] : []), ...(m.hidden ? ['Hidden'] : [])];
  return `<li class="card${m.hidden ? ' hidden' : ''}" data-model="${e(m.name)}">`
    + `<div class="card-head"><span class="card-title">${e(m.label)}</span><span class="meta">${e(m.name)} · ${e(formatBytes(m.bytes))} · ${e(useList(m.uses))}</span>`
    + (tags.length > 0 ? `<span class="badge">${tags.map(e).join(' · ')}</span>` : '') + `</div>`
    + `<p class="meta">${e(progress)}${loadText ? ` · ${e(loadText)}` : ''}${m.update !== undefined ? ` · ${e(updateText(m.update))}` : ''}</p>`
    + (m.mayNotFit ? `<p class="card-warning warn">This model is large for this computer's memory and may not fit.</p>` : '')
    + (d.kind === 'running' ? `<progress max="${e(String(m.bytes))}" value="${e(String(d.received ?? 0))}" aria-label="Download progress"></progress>` : '')
    + `<div class="actions">${buttons.join('')}</div></li>`;
}

const num = (v: number | undefined): string => (v === undefined ? '' : String(v));
function field(id: string, label: string, value: string, o: { type?: string; step?: string } = {}): string {
  return `<div class="field"><label for="${e(id)}">${e(label)}</label><input id="${e(id)}" type="${o.type ?? 'text'}"${o.step ? ` step="${o.step}"` : ''} value="${e(value)}"></div>`;
}

function modelForm(f: ModelForm): string {
  return `<section class="section editing" aria-labelledby="h-edit"><h2 id="h-edit">Edit ${e(f.name)}</h2>`
    + `<form data-form="model" data-name="${e(f.name)}">`
    + field('f-context', 'Context size (tokens)', String(f.contextTokens), { type: 'number' })
    + field('f-extra', 'Extra llama-server arguments', f.extraArgs)
    + `<h3>Default sampling</h3>`
    + field('f-temperature', 'Temperature', num(f.sampling.temperature), { type: 'number', step: 'any' })
    + field('f-topP', 'top_p', num(f.sampling.topP), { type: 'number', step: 'any' })
    + field('f-topK', 'top_k', num(f.sampling.topK), { type: 'number' })
    + field('f-maxTokens', 'Max tokens', num(f.sampling.maxTokens), { type: 'number' })
    + (f.otherOverridesMatch ? `<p class="hint">other overrides also match this model</p>` : '')
    + (f.error ? `<p class="card-warning warn" role="alert">${e(f.error)}</p>` : '')
    + `<div class="actions">${button('saveModel', 'Save', undefined, { cls: 'btn primary' })}${button('cancel', 'Cancel')}</div></form></section>`;
}

function addSection(a: AddState | undefined): string {
  const repo = a?.repo ?? '';
  const files = a?.files;
  const uses = new Set<BackendUse>(a?.uses ?? ['completions']);
  const list = files
    ? `<fieldset class="files"><legend>Pick a file</legend>${files.map((f, i) => `<label class="file${f.supported ? '' : ' unsupported'}"><input type="radio" name="add-file" id="add-file-${i}" value="${e(f.path)}"`
      + `${f.supported ? '' : ' disabled'}${a?.picked === f.path ? ' checked' : ''}> ${e(f.path)} <span class="muted">${e(formatBytes(f.bytes))}${f.reason ? ` · ${e(f.reason)}` : ''}</span></label>`).join('')}</fieldset>`
      + field('add-name', 'Name', a?.name ?? '')
      + `<fieldset class="uses"><legend>Uses</legend>${(['completions', 'nextEdit'] as const).map((u) => `<label><input type="checkbox" class="add-use" value="${u}"${uses.has(u) ? ' checked' : ''}> ${USE_LABEL[u]}</label>`).join('')}</fieldset>`
      + field('add-context', 'Context size (tokens)', num(a?.contextTokens ?? 8192), { type: 'number' })
      + `<div class="actions">${button('addFile', 'Add model', undefined, { cls: 'btn primary', disabled: a?.busy })}</div>` : '';
  return `<section class="section" aria-labelledby="h-add"><h2 id="h-add">Add model</h2>`
    + `<div class="line">${field('add-repo', 'Hugging Face repo (owner/name)', repo)}${button('addRepo', 'List files', undefined, { disabled: a?.busy })}${a ? button('cancel', 'Cancel') : ''}</div>`
    + (a?.busy ? `<p class="muted" role="status">Working...</p>` : '') + (a?.error ? `<p class="card-warning warn" role="alert">${e(a.error)}</p>` : '') + list + `</section>`;
}

function settingsSection(s: LocalPageState): string {
  return `<section class="section" aria-labelledby="h-settings"><h2 id="h-settings">Settings</h2>`
    + `<p class="line">Models folder: <code>${e(s.settings.modelsDir)}</code>${button('changeModelsDir', 'Change...')}</p>`
    + `<p class="line">Hugging Face token: ${s.settings.tokenSet ? 'set' : 'not set'}${button('setToken', s.settings.tokenSet ? 'Change' : 'Set')}${s.settings.tokenSet ? button('removeToken', 'Remove') : ''}</p></section>`;
}

export function renderPage(s: LocalPageState): string {
  const problems = s.problems.length > 0 ? `<ul class="card-warning warn problems">${s.problems.map((p) => `<li>${e(p)}</li>`).join('')}</ul>` : '';
  return `<main><header class="page-head"><h1>Local Models</h1></header>${problems}${server(s)}`
    + `<section class="section" aria-labelledby="h-models"><h2 id="h-models">Models</h2><ul class="models">${s.models.map(modelRow).join('')}</ul></section>`
    + (s.form ? modelForm(s.form) : '') + addSection(s.add) + settingsSection(s) + `</main>`;
}
