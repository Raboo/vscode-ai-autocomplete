import * as vscode from 'vscode';
import type { SessionStats } from '../completion/outcomes';
import type { RequestState, StatusAction, StatusSink, StatusState } from '../completion/requestStatus';
import { displayState, tooltipLines, type LastStatus, type MenuInputs } from './statusModel';

const TEXT: Record<StatusState, string> = {
  idle: '$(sparkle) AI',
  loading: '$(loading~spin) AI',
  error: '$(error) AI',
  disabled: '$(circle-slash) AI',
  snoozed: '$(clock) AI',
};
const MAX_TIMER_MS = 2 ** 31 - 1;

export interface StatusBarInputs {
  /** Whether completions or Next Edit runs; off shows the disabled state. */
  enabled(): boolean;
  /** Each feature's backend, for the tooltip (a feature that is off has none). */
  menu(): MenuInputs;
  snoozedUntil(): number;
  localOnly(): boolean;
  /** Requests, shown and median latency of this session; the accepted count is set with setStats. */
  stats(): Omit<SessionStats, 'accepted'>;
}

export class StatusBar implements StatusSink, vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  /** The latest request outcome; disabled and snoozed are applied on top of it by refresh(). */
  private last: { state: RequestState; detail?: string; action?: StatusAction } = { state: 'idle' };
  private shown: LastStatus = { state: 'idle' };
  private locked = false;
  private accepted = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly inputs: StatusBarInputs) {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.item.name = 'AI Autocomplete';
    this.item.command = 'aiAutocomplete.menu';
    this.locked = inputs.localOnly();
    this.refresh();
    this.item.show();
  }

  /** Text form of the displayed state, e.g. "idle" or "error: <detail>". */
  current(): string {
    return this.shown.detail ? `${this.shown.state}: ${this.shown.detail}` : this.shown.state;
  }

  /** The displayed state. */
  state(): StatusState {
    return this.shown.state;
  }

  set(state: RequestState, detail?: string, action?: StatusAction): void {
    this.last = { state, detail, action };
    this.refresh();
  }

  setLocalLock(on: boolean): void {
    this.locked = on;
    this.refresh();
  }

  setStats(accepted: number): void {
    this.accepted = accepted;
    this.refresh();
  }

  /** Re-evaluates the precedence (disabled, snoozed, last) and redraws; call after any input changed. */
  refresh(): void {
    const now = Date.now();
    const until = this.inputs.snoozedUntil();
    this.shown = displayState(this.inputs.enabled(), until, now, this.last);
    // An action belongs only to a shown error, not to disabled or snoozed.
    const action = this.shown.state === 'error' && this.last.state === 'error' ? this.last.action : undefined;
    this.item.command = action ? { command: action.command, arguments: action.args, title: 'Open' } : 'aiAutocomplete.menu';
    this.item.text = (this.locked ? '$(lock) ' : '') + TEXT[this.shown.state];
    this.item.tooltip = tooltipLines({ shown: this.shown, snoozedUntil: until, locked: this.locked, session: { ...this.inputs.stats(), accepted: this.accepted }, menu: this.inputs.menu() }).join('\n');
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const wait = until - now;
    if (this.inputs.enabled() && wait > 0 && wait <= MAX_TIMER_MS) this.timer = setTimeout(() => this.refresh(), wait + 5);
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.item.dispose();
  }
}
