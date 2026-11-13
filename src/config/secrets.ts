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
}
