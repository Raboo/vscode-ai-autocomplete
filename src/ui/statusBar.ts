import * as vscode from 'vscode';
import type { RequestState, StatusSink, StatusState } from '../completion/requestStatus';
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
  private last: { state: RequestState; detail?: string } = { state: 'idle' };
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

  set(state: RequestState, detail?: string): void {
    this.last = { state, detail };
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
    this.item.text = (this.locked ? '$(lock) ' : '') + TEXT[this.shown.state];
    const lines = [`AI Autocomplete: ${this.shown.state}`];
    if (this.shown.detail) lines.push(this.shown.detail);
    if (this.locked) lines.push('Local only: requests go to loopback or private-network hosts only');
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
