import type * as vscode from 'vscode';

export interface Log {
  debug(m: string): void;
  info(m: string): void;
  warn(m: string): void;
  error(m: string, e?: unknown): void;
}

export const nullLog: Log = { debug() {}, info() {}, warn() {}, error() {} };

export function createLog(ch: vscode.LogOutputChannel): Log {
  return {
    debug: (m) => ch.debug(m),
    info: (m) => ch.info(m),
    warn: (m) => ch.warn(m),
    error: (m, e) => (e === undefined ? ch.error(m) : ch.error(m, e instanceof Error ? e : String(e))),
  };
}
