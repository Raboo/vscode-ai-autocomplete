import * as vscode from 'vscode';
import { ErrorBackoff } from './backends/backoff';
import { createBackend } from './backends/index';
import type { FimBackend } from './backends/types';
import { SuggestionCache } from './completion/cache';
import { ExtraContextRing } from './completion/context';
import { ContextTracker } from './completion/contextTracker';
import { FimProvider } from './completion/provider';
import { Debouncer, InFlight } from './completion/scheduler';
import { isLocalEndpoint, isObviouslyLocal, memoizeIsLocal } from './config/localOnly';
import { Secrets } from './config/secrets';
import { readSettings } from './config/vscodeSettings';
import { createLog } from './log';
import { registerCommands, SNOOZE_KEY } from './ui/commands';
import { StatusBar } from './ui/statusBar';

const LOCAL_DEBOUNCE_MS = 75;
const REMOTE_DEBOUNCE_MS = 250;
const MIN_DEBOUNCE_MS = 50;
const MAX_DEBOUNCE_MS = 600;
const IS_LOCAL_TTL_MS = 60_000;

export function activate(context: vscode.ExtensionContext): { status: StatusBar; secrets: Secrets } {
  const sub = (d: vscode.Disposable): void => void context.subscriptions.push(d);
  const channel = vscode.window.createOutputChannel('AI Autocomplete', { log: true });
  sub(channel);
  const log = createLog(channel);
  const secrets = new Secrets(context.secrets);

  let settings = readSettings().settings;
  let backends = new Map<string, FimBackend>();
  const backoffs = new Map<string, ErrorBackoff>();
  const debouncers = new Map<string, Debouncer>();
  const isLocal = memoizeIsLocal((url) => isLocalEndpoint(url), IS_LOCAL_TTL_MS);
  let sessionSnooze = 0;
  const persisted = context.globalState.get<number>(SNOOZE_KEY, 0);
  if (typeof persisted === 'number') sessionSnooze = persisted;
  const snoozedUntil = (): number => sessionSnooze;

  let warnedProblems = false;
  let warnedNoBackends = false;
  const openSettings = (): void => void vscode.commands.executeCommand('workbench.action.openSettings', 'aiAutocomplete');
  const warnOnce = (problems: string[]): void => {
    if (problems.length > 0 && !warnedProblems) {
      warnedProblems = true;
      void vscode.window.showWarningMessage(`AI Autocomplete settings: ${problems.join('; ')}`, 'Open Settings').then((c) => c && openSettings());
    }
    if (settings.backends.length === 0 && !warnedNoBackends) {
      warnedNoBackends = true;
      void vscode.window.showInformationMessage('AI Autocomplete: no backends configured.', 'Open Settings').then((c) => c && openSettings());
    }
  };

  const rebuild = (): string[] => {
    const r = readSettings();
    settings = r.settings;
    backends = new Map(settings.backends.map((cfg) => [cfg.id, createBackend(cfg, () => secrets.get(cfg.id))]));
    for (const b of backoffs.values()) b.reset();
    debouncers.clear();
    isLocal.clear();
    return r.problems;
  };

  const status = new StatusBar({ enabled: () => settings.fim.enabled, snoozedUntil, localOnly: () => settings.privacy.localOnly });
  sub(status);

  const cache = new SuggestionCache();
  const ring = new ExtraContextRing();
  const inflight = new InFlight();
  const excluded = (doc: vscode.TextDocument): boolean => settings.fim.disableInFiles.some((pattern) => vscode.languages.match({ pattern }, doc) > 0);
  sub(new ContextTracker(ring, (doc) => !settings.fim.extraContext || excluded(doc)));

  const provider = new FimProvider({
    getSettings: () => settings,
    getBackend: (id) => backends.get(id),
    isLocal,
    cache,
    inflight,
    ring,
    status,
    log,
    snoozedUntil,
    backoff: (id) => {
      let b = backoffs.get(id);
      if (!b) backoffs.set(id, (b = new ErrorBackoff()));
      return b;
    },
    debouncer: (id) => {
      let d = debouncers.get(id);
      if (!d) {
        const url = backends.get(id)?.config.baseUrl;
        const initialMs = url && isObviouslyLocal(url) ? LOCAL_DEBOUNCE_MS : REMOTE_DEBOUNCE_MS;
        d = new Debouncer({ initialMs, minMs: MIN_DEBOUNCE_MS, maxMs: MAX_DEBOUNCE_MS, fixedMs: settings.fim.debounceMs });
        debouncers.set(id, d);
      }
      return d;
    },
  });
  sub(vscode.languages.registerInlineCompletionItemProvider({ pattern: '**' }, provider));

  for (const d of registerCommands({
    context,
    status,
    secrets,
    channel,
    log,
    snooze: {
      get: snoozedUntil,
      set: async (until, persist) => {
        sessionSnooze = until;
        if (persist) await context.globalState.update(SNOOZE_KEY, until);
      },
    },
  })) sub(d);

  sub(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration('aiAutocomplete')) return;
      const problems = rebuild();
      cache.clear();
      status.setLocalLock(settings.privacy.localOnly);
      status.refresh();
      warnOnce(problems);
    }),
  );

  warnOnce(rebuild());
  status.setLocalLock(settings.privacy.localOnly);
  return { status, secrets };
}

export function deactivate(): void {}
