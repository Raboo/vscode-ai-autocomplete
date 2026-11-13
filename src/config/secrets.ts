import type * as vscode from 'vscode';

const PREFIX = 'aiAutocomplete.apiKey.';

export class Secrets {
  constructor(private readonly s: vscode.SecretStorage) {}
  async get(id: string): Promise<string | undefined> {
    return this.s.get(PREFIX + id);
  }
  async set(id: string, v: string): Promise<void> {
    await this.s.store(PREFIX + id, v);
  }
  async delete(id: string): Promise<void> {
    await this.s.delete(PREFIX + id);
  }
  /** Fires with the backend id when its API key is stored or deleted (in any window). */
  onDidChange(listener: (id: string) => void): vscode.Disposable {
    return this.s.onDidChange((e) => {
      if (e.key.startsWith(PREFIX)) listener(e.key.slice(PREFIX.length));
    });
  }
}
