import * as vscode from 'vscode';
import { ErrorBackoff } from './backends/backoff';
import { createBackend } from './backends/index';
import { Capabilities } from './models/capabilities';
import type { FimBackend } from './backends/types';
import { SuggestionCache } from './completion/cache';
import { OutcomeLog } from './completion/outcomes';
import { ExtraContextRing } from './completion/context';
import { ContextTracker } from './completion/contextTracker';
import { resolveFim } from './completion/effective';
import { FimProvider } from './completion/provider';
import { Debouncer, InFlight } from './completion/scheduler';
import { isLocalEndpoint, isObviouslyLocal, memoizeIsLocal } from './config/localOnly';
import { Secrets } from './config/secrets';
import { readSettings } from './config/vscodeSettings';
import { RECIPES, type Recipe } from './local/recipes';
import { LocalServers } from './local/vscode/servers';
import { removeLocalModels, setUpLocalModel, type SetupDeps } from './local/vscode/setup';
import { createLog } from './log';
import { RecentSnippets } from './nextEdit/history';
import { NextEditController } from './nextEdit/vscode/controller';
import { BackendsPanel, type BackendsPanelDeps, type OpenOptions } from './ui/backendsPanel';
import { offerFirstBackend, registerCommands, SNOOZE_KEY } from './ui/commands';
import { StatusBar } from './ui/statusBar';
import { activity, menuInputs } from './ui/statusModel';

const LOCAL_DEBOUNCE_MS = 75;
const REMOTE_DEBOUNCE_MS = 250;
const MIN_DEBOUNCE_MS = 50;
const MAX_DEBOUNCE_MS = 600;
const IS_LOCAL_TTL_MS = 60_000;
const WARM_DELAY_MS = 250;

/** Kept for deactivate(), which has no context to reach the manager through. */
let localServers: LocalServers | undefined;

export function activate(context: vscode.ExtensionContext): {
  status: StatusBar;
  secrets: Secrets;
  backendsPanel: () => BackendsPanel | undefined;
  nativeNextEdit: boolean;
  nextEditPending: () => ReturnType<NextEditController['pendingEdit']>;
  /** Test runs only: swaps the recipes setup offers and the servers may start. */
  local?: { setRecipes(r: Recipe[] | undefined): void };
} {
  const sub = (d: vscode.Disposable): void => void context.subscriptions.push(d);
  const channel = vscode.window.createOutputChannel('AI Autocomplete', { log: true });
  sub(channel);
  const log = createLog(channel);
  const secrets = new Secrets(context.secrets);

  let settings = readSettings().settings;
  let backends = new Map<string, FimBackend>();
  const capabilities = new Capabilities();
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
      offerFirstBackend('AI Autocomplete needs a model to complete code. Set up a local model, or connect a server you already run.');
    }
  };

  const rebuild = (): string[] => {
    const r = readSettings();
    settings = r.settings;
    backends = new Map(settings.backends.map((cfg) => [cfg.id, createBackend(cfg, () => secrets.get(cfg.id))]));
    for (const b of backoffs.values()) b.reset();
    debouncers.clear();
    isLocal.clear();
    capabilities.clear();
    return r.problems;
  };

  const outcomes = new OutcomeLog();
  const status = new StatusBar({ enabled: () => activity(settings).on, menu: () => menuInputs(settings, false), snoozedUntil, localOnly: () => settings.privacy.localOnly, stats: () => outcomes.stats() });
  sub(status);

  const cache = new SuggestionCache();
  const ring = new ExtraContextRing();
  const inflight = new InFlight();
  const excluded = (doc: vscode.TextDocument): boolean => settings.fim.disableInFiles.some((pattern) => vscode.languages.match({ pattern }, doc) > 0);
  // Files completions may not use: no extra context, Next Edit history, snippet or request comes from them.
  const offLimits = (doc: vscode.TextDocument): boolean => settings.fim.disableInLanguages.includes(doc.languageId) || excluded(doc);
  const snippets = new RecentSnippets();
  // Extra context only comes from files completions are allowed in (the tracker also limits it to workspace files).
  sub(new ContextTracker(ring, (doc) => !settings.fim.extraContext || offLimits(doc), snippets));
  const backoff = (id: string): ErrorBackoff => {
    let b = backoffs.get(id);
    if (!b) backoffs.set(id, (b = new ErrorBackoff()));
    return b;
  };

  const nextEdit = new NextEditController({
    getSettings: () => settings,
    getBackend: (id) => backends.get(id),
    capabilities,
    backoff,
    isLocal,
    log,
    snoozedUntil,
    snippets,
    isExcluded: offLimits,
    // FIM's detected model first, so the same server is not asked twice.
    detectedModel: (b, signal) => Promise.resolve(provider.detectedModel(b.config.id) ?? b.detectModel(signal)),
  });
  sub(nextEdit);

  const provider: FimProvider = new FimProvider({
    getSettings: () => settings,
    getBackend: (id) => backends.get(id),
    isLocal,
    cache,
    inflight,
    ring,
    status,
    log,
    snoozedUntil,
    capabilities,
    outcomes,
    backoff,
    nextEdit,
    debouncer: (id) => {
      let d = debouncers.get(id);
      if (!d) {
        const cfg = backends.get(id)?.config;
        const url = cfg?.baseUrl;
        const fixedMs = cfg ? resolveFim(cfg, undefined, settings).values.debounceMs : settings.fim.debounceMs;
        const initialMs = url && isObviouslyLocal(url) ? LOCAL_DEBOUNCE_MS : REMOTE_DEBOUNCE_MS;
        d = new Debouncer({ initialMs, minMs: MIN_DEBOUNCE_MS, maxMs: MAX_DEBOUNCE_MS, fixedMs });
        debouncers.set(id, d);
      }
      return d;
    },
  });
  // Registering with metadata needs VS Code's proposed API (inlineCompletionsAdditions) and throws without it:
  // the same proposal shows inline edits, so the probe tells whether Next Edit may return them.
  let native: boolean;
  try {
    sub(vscode.languages.registerInlineCompletionItemProvider({ pattern: '**' }, provider, { displayName: 'AI Autocomplete' }));
    native = true;
  } catch {
    sub(vscode.languages.registerInlineCompletionItemProvider({ pattern: '**' }, provider));
    native = false;
  }
  nextEdit.native = native;
  log.info(native ? 'next edit: native inline edits available' : "next edit: native inline edits not available (VS Code's proposed API is not enabled for this extension)");

  // Warm-up: a document that becomes active fills local llama.cpp's prompt cache with the window at the cursor. Shortly after
  // the switch, so a cursor placed right after opening (go to definition, a search result) is the one used.
  let warmTimer: ReturnType<typeof setTimeout> | undefined;
  const warmSoon = (editor: vscode.TextEditor | undefined): void => {
    clearTimeout(warmTimer);
    if (!editor) return;
    warmTimer = setTimeout(() => {
      if (vscode.window.activeTextEditor === editor) provider.warm(editor.document, editor.selection.active);
    }, WARM_DELAY_MS);
  };
  sub(vscode.window.onDidChangeActiveTextEditor(warmSoon));
  sub({ dispose: () => clearTimeout(warmTimer) });

  const panelDeps: BackendsPanelDeps = {
    context,
    secrets,
    log,
    getSettings: () => settings,
    isLocal,
    detectedModel: (id) => provider.detectedModel(id),
    // As "Retry now" does, for the backend that answered the test completion.
    onTestPassed: (id) => {
      backoffs.get(id)?.reset();
      capabilities.forgetLearned(id);
      if (id === settings.fim.backendId) provider.clearError();
      log.info(`backend "${id}": connection test got a completion, backoff cleared`);
    },
  };
  const manageBackends = (o: OpenOptions): void => void BackendsPanel.show(panelDeps, o);
  sub({ dispose: () => BackendsPanel.current()?.dispose() });

  // A new (or deleted) key may fix a 401/403 that stopped requests to that backend.
  sub(
    secrets.onDidChange((id) => {
      backoffs.get(id)?.reset();
      capabilities.forgetLearned(id);
      if (id === settings.fim.backendId) provider.clearError();
      log.info(`backend "${id}": API key changed`);
    }),
  );

  // Tests swap in their own recipes, for setup and for the servers it records alike.
  let testRecipes: readonly Recipe[] | undefined;
  const recipes = (): readonly Recipe[] => testRecipes ?? RECIPES;
  const servers = new LocalServers({
    context,
    log,
    settings: () => settings,
    recipes,
    showLog: () => channel.show(true),
    // Requests that failed while the model loaded may have opened the backoff circuit: the server answers now.
    onReady: (id) => {
      backoffs.get(id)?.reset();
      // Only the completion backend's error is shown; another backend becoming ready must not hide it.
      if (id === settings.fim.backendId) provider.clearError();
    },
  });
  localServers = servers;
  sub(servers);
  const setupDeps: SetupDeps = { context, log, settings: () => settings, recipes, servers, openBackend: (id) => manageBackends({ focus: id }) };

  for (const d of registerCommands({
    context,
    outcomes,
    localServers: servers,
    localModels: { setUp: (arg) => setUpLocalModel(setupDeps, arg), remove: () => removeLocalModels(setupDeps) },
    status,
    secrets,
    channel,
    log,
    manageBackends,
    nativeNextEdit: () => native,
    completionAccepted: () => {
      // The accepted text is in the document now: the cursor sits where the next completion would be asked.
      const editor = vscode.window.activeTextEditor;
      if (editor) provider.prefetch(editor.document, editor.selection.active);
    },
    nextEditAccepted: () => nextEdit.accepted(),
    nextEditTab: () => nextEdit.nextEditTab(),
    nextEditDismiss: () => nextEdit.nextEditDismiss(),
    retry: () => {
      for (const b of backoffs.values()) b.reset();
      for (const id of backends.keys()) capabilities.forgetLearned(id);
      provider.clearError();
      log.info('retry: backoffs cleared');
    },
    snooze: {
      get: snoozedUntil,
      set: async (until, persist) => {
        sessionSnooze = until;
        if (until > Date.now()) nextEdit.snoozed();
        // An in-memory snooze ("Until restart", "Resume now") also clears an older persisted one.
        await context.globalState.update(SNOOZE_KEY, persist ? until : undefined);
      },
    },
  })) sub(d);

  const onSettingsChanged = (): void => {
    // Running requests were planned with the old settings (backend, exclusions, localOnly).
    inflight.abortEverything();
    const before = settings;
    const problems = rebuild();
    // A local backend that became selected starts its server; one no longer selected (or removed) stops it.
    void servers.selectionChanged(before, settings);
    cache.clear();
    // Chunks captured under the old settings may come from files that are now excluded.
    ring.clear();
    nextEdit.reset();
    // The shown outcome (e.g. "no completion template", "retrying in N s") belongs to the old settings.
    provider.clearError();
    provider.forgetLogged();
    status.setLocalLock(settings.privacy.localOnly);
    status.refresh();
    warnOnce(problems);
  };
  sub(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('aiAutocomplete')) onSettingsChanged();
    }),
  );
  // An added folder of a multi-root workspace may bring its own privacy.localOnly or fim.disableInFiles.
  sub(vscode.workspace.onDidChangeWorkspaceFolders(onSettingsChanged));

  warnOnce(rebuild());
  status.setLocalLock(settings.privacy.localOnly);
  // Not awaited: a model can take a minute to load, and activation must not wait for it.
  void servers.startSelected();
  warmSoon(vscode.window.activeTextEditor);
  return {
    status,
    secrets,
    backendsPanel: () => BackendsPanel.current(),
    nativeNextEdit: native,
    nextEditPending: () => nextEdit.pendingEdit(),
    ...(context.extensionMode === vscode.ExtensionMode.Test
      ? {
          local: {
            setRecipes: (r: Recipe[] | undefined) => {
              testRecipes = r;
            },
          },
        }
      : {}),
  };
}

/** Stops the llama-servers this window started (windows that adopted one start their own); VS Code waits briefly for the promise. */
export function deactivate(): Promise<void> | undefined {
  const servers = localServers;
  localServers = undefined;
  return servers?.stopAll();
}
