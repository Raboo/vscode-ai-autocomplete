import type * as vscode from 'vscode';

const PREFIX = 'aiAutocomplete.apiKey.';
/** The Hugging Face token has its own key, outside the backend key prefix. */
export const HF_TOKEN_KEY = 'aiAutocomplete.huggingFaceToken';

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
  async getHfToken(): Promise<string | undefined> {
    return this.s.get(HF_TOKEN_KEY);
  }
  async setHfToken(v: string): Promise<void> {
    await this.s.store(HF_TOKEN_KEY, v);
  }
  async deleteHfToken(): Promise<void> {
    await this.s.delete(HF_TOKEN_KEY);
  }
  /** Fires with the backend id when its API key is stored or deleted (in any window). */
  onDidChange(listener: (id: string) => void): vscode.Disposable {
    return this.s.onDidChange((e) => {
      if (e.key.startsWith(PREFIX)) listener(e.key.slice(PREFIX.length));
    });
  }
}
