import { createBackend } from '../backends';
import { nextEditModel as effectiveNextEditModel, resolveFim } from '../completion/effective';
import { noRouteFix, noRouteText, planRoute, whyNoRoute, type FimRoute, type NoRoute } from '../completion/route';
import { parseBackendEntry, type Settings } from '../config/settings';
import { nextEditFormatLabel, nextEditOnlyNote } from '../nextEdit/formats';
import type { BackendConfig } from '../types';
import { fieldViews, formWarnings, knownChanged, useFromUnknown, validateForm } from './form';
import type { BackendForm, CardView, Dot, EditView, PageState, TestStep } from './protocol';
import { SERVER_TYPES, serverTypeOf } from './serverTypes';

export interface EditDraft {
  cardId: string | null; form: BackendForm; models?: { id: string; tag: string }[]; modelsError?: string; testing: boolean; test?: TestStep[];
}
export interface PageInputs {
  settings: Settings; rawBackends: unknown; inUseId?: string; nextEditInUseId?: string; keysStored: ReadonlySet<string>;
  /** isLocal per backend id, precomputed by the host. */
  local: ReadonlyMap<string, boolean>;
  /** Models detected this session (provider or tests). */
  detected: ReadonlyMap<string, string>;
  /** Last test per backend id. */
  tests: ReadonlyMap<string, TestStep[]>;
  edit?: EditDraft;
}

/** lock > red > yellow > green > grey. */
export function dotFor(steps: TestStep[] | undefined, offlineWarning: boolean, locked: boolean): Dot {
  if (locked) return 'lock';
  if (steps?.some((s) => s.state === 'fail')) return 'red';
  if (offlineWarning || steps?.some((s) => s.state === 'warn')) return 'yellow';
  if (steps && steps.length > 0) return 'green';
  return 'grey';
}

const typeLabel = (id: string): string => SERVER_TYPES.find((t) => t.id === id)?.label ?? id;

/** How the backend would send `model`: its route (or why there is none) and whether the model's thinking cannot be switched off. */
function planFor(cfg: BackendConfig, model: string, s: Settings): { route: FimRoute; cannotDisable: boolean } | { why: NoRoute } {
  const caps = createBackend(cfg, async () => undefined).routes();
  const values = resolveFim(cfg, model, s).values;
  const route = planRoute(cfg.kind, caps, values, cfg.fimMode);
  return route === 'unsupported' ? { why: whyNoRoute(caps, cfg.fimMode) } : { route, cannotDisable: values.thinking === 'cannotDisable' };
}

/** The model list's tag for `model`: "ready", "chat prompt" (", cannot turn thinking off" when it cannot be turned off), or why the backend has no route for it. */
export function modelTag(cfg: BackendConfig, model: string, s: Settings, thinkingMandatory = false): string {
  const p = planFor(cfg, model, s);
  if ('why' in p) return noRouteText(p.why, cfg.fimMode, cfg.kind);
  if (p.route !== 'chat') return 'ready';
  return p.cannotDisable || thinkingMandatory ? 'chat prompt, cannot turn thinking off' : 'chat prompt';
}

/** The model list's tag for `model`: the completion tag with Completions ticked; otherwise the format Next Edit would use (completion routes mean nothing there). */
export function modelListTag(cfg: BackendConfig, model: string, s: Settings, thinkingMandatory = false): string {
  return cfg.use.completions ? modelTag(cfg, model, s, thinkingMandatory) : nextEditFormatLabel(s.nextEdit.format, model);
}

function routeWarning(cfg: BackendConfig, model: string | undefined, s: Settings): string | undefined {
  const nextEditOnly = cfg.use.completions ? nextEditOnlyNote(model) : undefined;
  if (nextEditOnly) return `${nextEditOnly.text}; ${nextEditOnly.hint}`;
  const p = model ? planFor(cfg, model, s) : undefined;
  if (p === undefined) return undefined;
  if ('why' in p) {
    if (p.why === 'mode') return noRouteText(p.why, cfg.fimMode);
    // Mistral's FIM endpoint serves Codestral models only: a template cannot help there.
    return cfg.kind === 'mistral' ? `This model cannot complete through Mistral's FIM endpoint; ${noRouteFix(false, cfg.kind)}` : 'No completion template for this model';
  }
  return p.route === 'chat' && p.cannotDisable ? 'This model cannot turn thinking off; completions are disabled' : undefined;
}

export function buildPageState(i: PageInputs): PageState {
  const { settings } = i;
  const entries: BackendConfig[] = [];
  const seen = new Set<string>();
  const problems: string[] = [];
  if (Array.isArray(i.rawBackends)) {
    (i.rawBackends as unknown[]).forEach((raw, n) => {
      const cfg = parseBackendEntry(raw, n, seen, problems);
      if (cfg) entries.push(cfg);
    });
  }
  const ids = entries.map((c) => c.id);
  const isLocked = (id: string): boolean => settings.privacy.localOnly && !(i.local.get(id) ?? false);

  const cards = entries.map((cfg): CardView => {
    const locked = isLocked(cfg.id);
    const detected = i.detected.get(cfg.id);
    // The completion model and its route warning exist only for a backend used for completions.
    const model = cfg.use.completions ? cfg.fimModel ?? detected : undefined;
    const nextEditModel = cfg.use.nextEdit ? effectiveNextEditModel(cfg, detected) : undefined;
    const warning = locked ? 'not used here (local only)' : cfg.use.completions ? routeWarning(cfg, model, settings) : undefined;
    const test = i.tests.get(cfg.id);
    return {
      id: cfg.id, typeLabel: typeLabel(serverTypeOf(cfg)), baseUrl: cfg.baseUrl,
      ...(model !== undefined ? { model } : {}), modelDetected: cfg.use.completions && cfg.fimModel === undefined && detected !== undefined,
      ...(nextEditModel !== undefined ? { nextEditModel } : {}), uses: { ...cfg.use },
      inUse: cfg.id === i.inUseId, nextEditInUse: cfg.id === i.nextEditInUseId, keyStored: i.keysStored.has(cfg.id),
      ...(warning ? { warning } : {}), dot: dotFor(test, warning !== undefined, locked), ...(test ? { test } : {}),
    };
  });

  let edit: EditView | undefined;
  if (i.edit) {
    const d = i.edit;
    // Copy field by field: whatever else the incoming object carries must never reach the page.
    const form: BackendForm = {
      ...(d.form.originalId !== undefined ? { originalId: d.form.originalId } : {}),
      type: d.form.type, id: d.form.id, baseUrl: d.form.baseUrl, model: d.form.model, nextEditModel: d.form.nextEditModel,
      use: useFromUnknown(d.form.use), changed: knownChanged(d.form.changed),
    };
    const own = form.originalId;
    const found = own !== undefined ? i.detected.get(own) : undefined;
    // The completion model: only for a backend used for completions.
    const model = !form.use.completions ? undefined : form.model !== '' ? form.model : found;
    const neModel = form.nextEditModel !== '' ? form.nextEditModel : form.use.completions ? model : found;
    const errors = validateForm(form, ids.filter((id) => id !== own));
    const warnings = formWarnings(form, model, settings);
    if (form.use.completions && model === undefined) warnings.push('model not detected yet: Test or reload the list to detect it');
    const keyId = own ?? d.cardId ?? undefined;
    edit = {
      cardId: d.cardId, form, keyMode: SERVER_TYPES.find((t) => t.id === form.type)?.key ?? 'optional',
      keyStored: keyId !== undefined && i.keysStored.has(keyId), fields: fieldViews(form, model, settings, errors),
      ...(form.use.nextEdit ? { nextEditFormat: nextEditFormatLabel(settings.nextEdit.format, neModel) } : {}),
      ...(d.models ? { models: d.models.map((m) => ({ id: m.id, tag: m.tag })) } : {}), ...(d.modelsError !== undefined ? { modelsError: d.modelsError } : {}),
      errors: errors.map((e) => ({ field: e.field, message: e.message })), warnings, testing: d.testing, ...(d.test ? { test: d.test } : {}),
    };
  }

  return {
    completionsOn: settings.fim.enabled, localOnly: settings.privacy.localOnly, cards, ...(edit ? { edit } : {}),
    serverTypes: SERVER_TYPES.map(({ id, label }) => ({ id, label })),
  };
}
