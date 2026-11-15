import * as vscode from 'vscode';
import type { RequestState, StatusAction, StatusSink, StatusState } from '../completion/requestStatus';
import { displayState, type LastStatus } from './statusModel';

const TEXT: Record<StatusState, string> = {
  idle: '$(sparkle) AI',
  loading: '$(loading~spin) AI',
  error: '$(error) AI',
  disabled: '$(circle-slash) AI',
  snoozed: '$(clock) AI',
};
const MAX_TIMER_MS = 2 ** 31 - 1;

export interface StatusBarInputs {
  enabled(): boolean;
  snoozedUntil(): number;
  localOnly(): boolean;
}

export class StatusBar implements StatusSink, vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  /** The latest request outcome; disabled and snoozed are applied on top of it by refresh(). */
  private last: { state: RequestState; detail?: string; action?: StatusAction } = { state: 'idle' };
  private shown: LastStatus = { state: 'idle' };
  private locked = false;
  private thinking: string | undefined;
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
    const text = this.shown.detail ? `${this.shown.state}: ${this.shown.detail}` : this.shown.state;
    return this.thinking !== undefined ? `${text} [thinking]` : text;
  }

  /** The displayed state. */
  state(): StatusState {
    return this.shown.state;
  }

  set(state: RequestState, detail?: string, action?: StatusAction): void {
    this.last = { state, detail, action };
    this.refresh();
  }

  /** Shows a warning icon and a tooltip line while a model still thinks; undefined clears it. */
  setThinking(note: string | undefined): void {
    if (this.thinking === note) return;
    this.thinking = note;
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
    this.item.text = (this.locked ? '$(lock) ' : '') + TEXT[this.shown.state] + (this.thinking !== undefined ? ' $(warning)' : '');
    const lines = [`AI Autocomplete: ${this.shown.state}`];
    if (this.shown.detail) lines.push(this.shown.detail);
    if (this.locked) lines.push('Local only: requests go to loopback or private-network hosts only');
    if (this.thinking !== undefined) lines.push(`Thinking: ${this.thinking}`);
    lines.push(`Accepted this session: ${this.accepted}`);
    this.item.tooltip = lines.join('\n');
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
