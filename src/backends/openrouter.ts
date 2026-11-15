import type { BackendConfig } from '../types';
import { streamOpenAiChat } from './chat';
import { authHeaders, getJson, joinUrl } from './http';
import { MissingApiKeyError } from './mistral';
import { OpenAiCompatBackend } from './openaiCompat';
import { LIST_MODELS_TIMEOUT_MS, type ApiKeyProvider, type ChatEvent, type ChatRequest, type RouteCaps, type ServerInfo } from './types';

export const OPENROUTER_URL = 'https://openrouter.ai/api/v1';

/** Chat only: OpenRouter documents no FIM route. Sends no attribution headers (HTTP-Referer, X-Title). */
export class OpenRouterBackend extends OpenAiCompatBackend {
  constructor(
    config: BackendConfig,
    private readonly key: ApiKeyProvider,
  ) {
    super(config, key);
  }

  routes(): RouteCaps {
    return { native: false, template: false, chat: true, nativeChatModels: false };
  }

  streamChat(req: ChatRequest): AsyncIterable<ChatEvent> {
    return this.openRouterChat(req);
  }

  /** Without a key OpenRouter answers 401, after the code was sent: check first, as Mistral does. */
  private async *openRouterChat(req: ChatRequest): AsyncGenerator<ChatEvent> {
    const key = await this.key();
    if (!key) {
      throw new MissingApiKeyError(this.config.id);
    }
    yield* streamOpenAiChat(joinUrl(this.config.baseUrl, 'chat/completions'), authHeaders(this.config, key), req, true);
  }

  private async authHeaders(): Promise<Record<string, string>> {
    return authHeaders(this.config, await this.key());
  }

  /** About 470 models: the user picks one, so there is nothing to detect. */
  async detectModel(): Promise<undefined> {
    return undefined;
  }

  async listModels(signal: AbortSignal, timeoutMs = LIST_MODELS_TIMEOUT_MS): Promise<ServerInfo> {
    const body = await getJson(joinUrl(this.config.baseUrl, 'models'), { headers: await this.authHeaders(), signal, timeoutMs });
    const data = (body as { data?: unknown } | null)?.data;
    const models: string[] = [];
    const contextWindows: Record<string, number> = {};
    const thinkingMandatory: string[] = [];
    for (const e of Array.isArray(data) ? data : []) {
      const entry = e as { id?: unknown; context_length?: unknown; reasoning?: { mandatory?: unknown } | null } | null;
      if (!entry || typeof entry.id !== 'string') {
        continue;
      }
      models.push(entry.id);
      if (typeof entry.context_length === 'number' && Number.isFinite(entry.context_length)) {
        Object.defineProperty(contextWindows, entry.id, { value: entry.context_length, enumerable: true, writable: true, configurable: true });
      }
      if (entry.reasoning?.mandatory === true) {
        thinkingMandatory.push(entry.id);
      }
    }
    return { models, contextWindows, thinkingMandatory };
  }
}
