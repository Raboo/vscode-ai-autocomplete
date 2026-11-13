import { createBackend } from '../backends';
import { resolveFim } from '../completion/effective';
import { planRoute } from '../completion/route';
import { parseBackendEntry, type Settings } from '../config/settings';
import type { BackendConfig } from '../types';
import { fieldViews, formWarnings, validateForm } from './form';
import type { BackendForm, CardView, Dot, EditView, PageState, TestStep } from './protocol';
import { SERVER_TYPES, serverTypeOf } from './serverTypes';

export interface EditDraft {
  cardId: string | null; form: BackendForm; models?: { id: string; ready: boolean }[]; modelsError?: string; testing: boolean; test?: TestStep[];
}
export interface PageInputs {
  settings: Settings; rawBackends: unknown; inUseId?: string; keysStored: ReadonlySet<string>;
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

function templateWarning(cfg: BackendConfig, model: string | undefined, s: Settings): boolean {
  if (!model) return false;
  const native = createBackend(cfg, async () => undefined).supportsNativeFim();
  return planRoute(cfg.kind, native, resolveFim(cfg, model, s).values, cfg.fimMode) === 'unsupported';
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
    const model = cfg.fimModel ?? detected;
    const warning = locked ? 'not used here (local only)'
      : templateWarning(cfg, model, settings) ? 'No completion template for this model' : undefined;
    const test = i.tests.get(cfg.id);
    return {
      id: cfg.id, typeLabel: typeLabel(serverTypeOf(cfg)), baseUrl: cfg.baseUrl,
      ...(model !== undefined ? { model } : {}), modelDetected: cfg.fimModel === undefined && detected !== undefined,
      inUse: cfg.id === i.inUseId, keyStored: i.keysStored.has(cfg.id),
      ...(warning ? { warning } : {}), dot: dotFor(test, warning !== undefined, locked), ...(test ? { test } : {}),
    };
  });

  let edit: EditView | undefined;
  if (i.edit) {
    const d = i.edit;
    // Copy field by field: whatever else the incoming object carries must never reach the page.
    const form: BackendForm = {
      ...(d.form.originalId !== undefined ? { originalId: d.form.originalId } : {}),
      type: d.form.type, id: d.form.id, baseUrl: d.form.baseUrl, model: d.form.model, changed: { ...d.form.changed },
    };
    const own = form.originalId;
    const model = form.model !== '' ? form.model : own !== undefined ? i.detected.get(own) : undefined;
    const errors = validateForm(form, ids.filter((id) => id !== own));
    const warnings = formWarnings(form, model, settings);
    if (model === undefined) warnings.push('model not detected yet: Test or reload the list to detect it');
    const keyId = own ?? d.cardId ?? undefined;
    edit = {
      cardId: d.cardId, form, keyMode: SERVER_TYPES.find((t) => t.id === form.type)?.key ?? 'optional',
      keyStored: keyId !== undefined && i.keysStored.has(keyId), fields: fieldViews(form, model, settings, errors),
      ...(d.models ? { models: d.models.map((m) => ({ id: m.id, ready: m.ready })) } : {}), ...(d.modelsError !== undefined ? { modelsError: d.modelsError } : {}),
      errors: errors.map((e) => ({ field: e.field, message: e.message })), warnings, testing: d.testing, ...(d.test ? { test: d.test } : {}),
    };
  }

  return {
    completionsOn: settings.fim.enabled, localOnly: settings.privacy.localOnly, cards, ...(edit ? { edit } : {}),
    serverTypes: SERVER_TYPES.map(({ id, label }) => ({ id, label })),
  };
}
