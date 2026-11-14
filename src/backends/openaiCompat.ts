import type { BackendConfig, HostFlavor } from '../types';
import { inferHostFlavor, isHostedFlavor } from './hostFlavor';
import { authHeaders, getJson, joinUrl, postJson, throwIfStreamError } from './http';
import { parseSse } from './sse';
import { LIST_MODELS_TIMEOUT_MS, type ApiKeyProvider, type FimBackend, type FimRequest, type ServerInfo } from './types';

const HOSTED_MAX_STOPS = 4;

export class OpenAiCompatBackend implements FimBackend {
  private readonly flavor: HostFlavor;

  constructor(
    readonly config: BackendConfig,
    private readonly apiKey: ApiKeyProvider,
  ) {
    this.flavor = inferHostFlavor(config);
  }

  supportsNativeFim(): boolean {
    return this.flavor === 'deepseek' || this.flavor === 'ollama';
  }

  private async headers(): Promise<Record<string, string>> {
    return authHeaders(this.config, await this.apiKey());
  }

  async listModels(signal: AbortSignal, timeoutMs = LIST_MODELS_TIMEOUT_MS): Promise<ServerInfo> {
    return this.fetchModels(signal, timeoutMs, true);
  }

  /** `withContext: false` skips LM Studio's second request, which only adds context windows. */
  private async fetchModels(signal: AbortSignal, timeoutMs: number, withContext: boolean): Promise<ServerInfo> {
    const headers = await this.headers();
    const models: string[] = [];
    const contextWindows: Record<string, number> = {};
    const entries = (body: unknown): { id?: unknown; [k: string]: unknown }[] => {
      const data = (body as { data?: unknown } | null)?.data;
      return Array.isArray(data) ? (data as { id?: unknown }[]).filter((e) => e && typeof e === 'object') : [];
    };
    const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

    for (const e of entries(await getJson(joinUrl(this.config.baseUrl, 'models'), { headers, signal, timeoutMs }))) {
      if (typeof e.id === 'string' && e.id) {
        models.push(e.id);
        if (num(e.max_model_len)) {
          contextWindows[e.id] = e.max_model_len;
        }
      }
    }
    if (withContext && this.flavor === 'lmstudio') {
      try {
        const url = `${new URL(this.config.baseUrl).origin}/api/v0/models`;
        for (const e of entries(await getJson(url, { headers, signal, timeoutMs }))) {
          if (typeof e.id === 'string' && e.id && num(e.loaded_context_length)) {
            contextWindows[e.id] = e.loaded_context_length;
          }
        }
      } catch {
        // best effort: LM Studio's native API is optional
      }
    }
    return { models, contextWindows };
  }

  async detectModel(signal: AbortSignal): Promise<string | undefined> {
    try {
      // On the completion path: one request, no context windows.
      const { models } = await this.fetchModels(signal, LIST_MODELS_TIMEOUT_MS, false);
      return models.length === 1 ? models[0] : undefined;
    } catch {
      return undefined;
    }
  }

  async *streamFim(req: FimRequest): AsyncGenerator<string> {
    const { payload, sampling } = req;
    const hosted = isHostedFlavor(this.flavor);
    const body = {
      ...(req.model ? { model: req.model } : {}),
      ...(payload.route === 'native' ? { prompt: payload.prefix, suffix: payload.suffix } : { prompt: payload.prompt }),
      max_tokens: sampling.maxTokens,
      ...(sampling.temperature !== undefined ? { temperature: sampling.temperature } : {}),
      ...(sampling.topP !== undefined ? { top_p: sampling.topP } : {}),
      ...(!hosted && sampling.topK !== undefined ? { top_k: sampling.topK } : {}),
      stop: hosted ? req.stop.slice(0, HOSTED_MAX_STOPS) : req.stop,
      stream: true,
      ...req.extraBody,
    };

    const res = await postJson(joinUrl(this.config.baseUrl, 'completions'), body, {
      headers: await this.headers(),
      signal: req.signal,
      timeoutMs: req.timeoutMs,
    });
    if (!res.body) {
      return;
    }
    for await (const data of parseSse(res.body)) {
      if (data === '') {
        continue;
      }
      const ev = JSON.parse(data) as { choices?: { text?: unknown }[] };
      throwIfStreamError(ev);
      const text = ev.choices?.[0]?.text;
      if (typeof text === 'string' && text !== '') {
        yield text;
      }
    }
  }
}
