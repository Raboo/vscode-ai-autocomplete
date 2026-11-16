import type { BackendConfig, HostFlavor } from '../types';
import { inferHostFlavor, isHostedFlavor } from './hostFlavor';
import { authHeaders, getJson, joinUrl, postJson, throwIfStreamError } from './http';
import { streamOpenAiChat } from './chat';
import { repairFirstSpace } from './firstSpace';
import { parseSse } from './sse';
import { LIST_MODELS_TIMEOUT_MS, type ApiKeyProvider, type ChatEvent, type ChatRequest, type FimBackend, type FimRequest, type RouteCaps, type ServerInfo } from './types';

const HOSTED_MAX_STOPS = 4;
/** How long an LM Studio model missing from its model list waits before the list is asked for again. */
const ENGINES_RETRY_MS = 30_000;

export class OpenAiCompatBackend implements FimBackend {
  private readonly flavor: HostFlavor;

  constructor(
    readonly config: BackendConfig,
    private readonly apiKey: ApiKeyProvider,
  ) {
    this.flavor = inferHostFlavor(config);
  }

  routes(): RouteCaps {
    return {
      native: this.flavor === 'deepseek' || this.flavor === 'ollama',
      template: this.flavor !== 'strata',
      chat: true,
      nativeChatModels: this.flavor === 'deepseek',
    };
  }

  streamChat(req: ChatRequest): AsyncIterable<ChatEvent> {
    return this.chat(req);
  }

  private async *chat(req: ChatRequest): AsyncGenerator<ChatEvent> {
    const sent = this.flavor === 'lmstudio' ? { ...req, stop: this.serverStops(req.stop) } : req;
    yield* streamOpenAiChat(joinUrl(this.config.baseUrl, 'chat/completions'), await this.headers(), sent, isHostedFlavor(this.flavor));
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
        } else if (num((e.meta as { n_ctx?: unknown } | null | undefined)?.n_ctx)) {
          contextWindows[e.id] = (e.meta as { n_ctx: number }).n_ctx;
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
    const text = this.streamFimText(req);
    if (!req.firstSpace) return yield* text;
    const { held } = req.firstSpace;
    // The line-start rule adds a space, so it needs a model known to run on MLX; the hold-back is right on any engine.
    const lineStart = held === '' && (await this.runsOnMlx(req.model, req.signal));
    yield* repairFirstSpace(text, { held, lineStart }, req.onUnrepaired);
  }

  /** LM Studio's engine per model (`/api/v0/models` `compatibility_type`), listed once and again for a model it did not know after a while. */
  private engines: { at: number; mlx: Set<string>; known: Set<string> } | undefined;

  private async runsOnMlx(model: string | undefined, signal: AbortSignal): Promise<boolean> {
    if (model === undefined) return false;
    const e = this.engines;
    if (!e || (!e.known.has(model) && Date.now() - e.at > ENGINES_RETRY_MS)) {
      const next = { at: Date.now(), mlx: new Set<string>(), known: new Set<string>() };
      try {
        const body = await getJson(`${new URL(this.config.baseUrl).origin}/api/v0/models`, { headers: await this.headers(), signal, timeoutMs: LIST_MODELS_TIMEOUT_MS });
        const data = (body as { data?: unknown } | null)?.data;
        for (const m of Array.isArray(data) ? (data as { id?: unknown; compatibility_type?: unknown }[]) : []) {
          if (typeof m?.id !== 'string') continue;
          next.known.add(m.id);
          if (m.compatibility_type === 'mlx') next.mlx.add(m.id);
        }
      } catch {
        // best effort: without the list, no space is added
      }
      this.engines = next;
    }
    return this.engines!.mlx.has(model);
  }

  /**
   * The stops sent to the server. Hosted APIs accept only 4. LM Studio errors ("StopIteration") instead of answering when
   * generation ends at the token limit inside a partial match of a stop with whitespace, such as `\n\n\n`, so it gets only the
   * others; completions and chat apply every stop themselves. Next Edit's raw formats rely on the server's stops and must keep
   * theirs free of whitespace (test/unit/nextEdit pins that).
   */
  private serverStops(stop: string[]): string[] {
    if (this.flavor === 'lmstudio') return stop.filter((s) => !/\s/.test(s));
    return isHostedFlavor(this.flavor) ? stop.slice(0, HOSTED_MAX_STOPS) : stop;
  }

  private async *streamFimText(req: FimRequest): AsyncGenerator<string> {
    const { payload, sampling } = req;
    const hosted = isHostedFlavor(this.flavor);
    const stop = this.serverStops(req.stop);
    const body = {
      ...(req.model ? { model: req.model } : {}),
      ...(payload.route === 'native' ? { prompt: payload.prefix, suffix: payload.suffix } : { prompt: payload.prompt }),
      max_tokens: sampling.maxTokens,
      ...(sampling.temperature !== undefined ? { temperature: sampling.temperature } : {}),
      ...(sampling.topP !== undefined ? { top_p: sampling.topP } : {}),
      ...(!hosted && sampling.topK !== undefined ? { top_k: sampling.topK } : {}),
      ...(stop.length > 0 ? { stop } : {}),
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
    let truncated = false;
    for await (const data of parseSse(res.body)) {
      if (data === '') {
        continue;
      }
      const ev = JSON.parse(data) as { choices?: { text?: unknown; finish_reason?: unknown }[] };
      throwIfStreamError(ev);
      if (!truncated && ev.choices?.[0]?.finish_reason === 'length') {
        truncated = true;
        req.onTruncated?.();
      }
      const text = ev.choices?.[0]?.text;
      if (typeof text === 'string' && text !== '') {
        yield text;
      }
    }
  }
}
