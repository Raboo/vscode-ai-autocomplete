import type { BackendConfig } from '../types';
import { authHeaders, getJson, joinUrl, postJson, throwIfStreamError } from './http';
import { streamOpenAiChat } from './chat';
import { parseSse } from './sse';
import { LIST_MODELS_TIMEOUT_MS, type ApiKeyProvider, type ChatEvent, type ChatRequest, type FimBackend, type FimRequest, type RouteCaps, type ServerInfo } from './types';

const SLOTS_TIMEOUT_MS = 3000;
const SLOTS_RETRY_MS = 30_000;

export class LlamaCppBackend implements FimBackend {
  /** `total_slots` from the last `/props` read; undefined until then. */
  private totalSlots: number | undefined;
  private slotsFetch: Promise<void> | undefined;
  private slotsFailedAt = 0;

  constructor(
    readonly config: BackendConfig,
    private readonly apiKey: ApiKeyProvider,
  ) {}

  routes(): RouteCaps {
    return { native: true, template: true, chat: true, nativeChatModels: false };
  }

  streamChat(req: ChatRequest): AsyncIterable<ChatEvent> {
    return this.chat(req);
  }

  private async *chat(req: ChatRequest): AsyncGenerator<ChatEvent> {
    try {
      yield* streamOpenAiChat(joinUrl(this.config.baseUrl, '/v1/chat/completions'), await this.authHeaders(), req, false);
    } catch (err) {
      this.forgetSlotsUnlessAborted(req.signal);
      throw err;
    }
  }

  /** `total_slots` as last read from `/props`; undefined until read, and again after a failed request. */
  slotCount(): number | undefined {
    return this.totalSlots;
  }

  /**
   * A failed request (HTTP, connection or stream error) may mean the server was restarted with another layout: the slot
   * count is read again before `id_slot` is sent again. An aborted request says nothing about the server.
   */
  private forgetSlotsUnlessAborted(signal: AbortSignal): void {
    if (!signal.aborted) this.totalSlots = undefined;
  }

  private async authHeaders(): Promise<Record<string, string>> {
    return authHeaders(this.config, await this.apiKey());
  }

  async listModels(signal: AbortSignal, timeoutMs = LIST_MODELS_TIMEOUT_MS): Promise<ServerInfo> {
    const props = (await getJson(joinUrl(this.config.baseUrl, '/props'), {
      headers: await this.authHeaders(),
      signal,
      timeoutMs,
    })) as { model_alias?: unknown; model_path?: unknown; n_ctx?: unknown; total_slots?: unknown; default_generation_settings?: { n_ctx?: unknown } } | null;
    if (typeof props?.total_slots === 'number') {
      this.totalSlots = props.total_slots;
    } else {
      this.slotsFailedAt = Date.now(); // this read had no slot count: streamFim does not ask again for 30 s
    }
    let model: string | undefined;
    if (typeof props?.model_alias === 'string' && props.model_alias) {
      model = props.model_alias;
    } else if (typeof props?.model_path === 'string' && props.model_path) {
      const base = props.model_path.split(/[\\/]/).pop() ?? '';
      model = base.replace(/\.gguf$/i, '') || undefined;
    }
    if (!model) {
      return { models: [], contextWindows: {} };
    }
    const nCtx = props?.default_generation_settings?.n_ctx ?? props?.n_ctx;
    return {
      models: [model],
      contextWindows: typeof nCtx === 'number' && Number.isFinite(nCtx) ? { [model]: nCtx } : {},
    };
  }

  /** Reads `/props` once for `total_slots` when no model detection did (settings name the model). Never awaited by a request; its own short timeout, not the request's signal. */
  private learnSlots(): void {
    if (this.totalSlots !== undefined || this.slotsFetch || Date.now() - this.slotsFailedAt < SLOTS_RETRY_MS) {
      return;
    }
    this.slotsFetch = this.listModels(new AbortController().signal, SLOTS_TIMEOUT_MS).then(
      () => {
        this.slotsFetch = undefined;
      },
      () => {
        this.slotsFetch = undefined;
        this.slotsFailedAt = Date.now();
      },
    );
  }

  async detectModel(signal: AbortSignal): Promise<string | undefined> {
    try {
      return (await this.listModels(signal)).models[0];
    } catch {
      return undefined;
    }
  }

  async *streamFim(req: FimRequest): AsyncGenerator<string> {
    this.learnSlots();
    const { payload, sampling } = req;
    const common = {
      ...(req.model ? { model: req.model } : {}),
      n_predict: sampling.maxTokens,
      ...(sampling.temperature !== undefined ? { temperature: sampling.temperature } : {}),
      ...(sampling.topP !== undefined ? { top_p: sampling.topP } : {}),
      ...(sampling.topK !== undefined ? { top_k: sampling.topK } : {}),
      stop: req.stop,
      stream: true,
      cache_prompt: true,
      ...(req.timeMaxPredictMs !== undefined ? { t_max_predict_ms: req.timeMaxPredictMs } : {}),
      // Exactly 2 slots is the layout the local helper starts (one per use); any other layout is left to the server.
      ...(this.totalSlots === 2 ? { id_slot: req.slot === 'nextEdit' ? 1 : 0 } : {}),
    };
    const isNative = payload.route === 'native';
    const body = isNative
      ? {
          input_prefix: payload.prefix,
          input_suffix: payload.suffix,
          input_extra: payload.extra.map((f) => ({ filename: f.path, text: f.text })),
          prompt: '',
          ...common,
          ...req.extraBody,
        }
      : { prompt: payload.prompt, ...common, ...req.extraBody };

    try {
      yield* this.fimStream(isNative, body, req);
    } catch (err) {
      this.forgetSlotsUnlessAborted(req.signal);
      throw err;
    }
  }

  private async *fimStream(isNative: boolean, body: Record<string, unknown>, req: FimRequest): AsyncGenerator<string> {
    const res = await postJson(joinUrl(this.config.baseUrl, isNative ? '/infill' : '/completion'), body, {
      headers: await this.authHeaders(),
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
      const ev = JSON.parse(data) as { content?: unknown; stop?: unknown; stop_type?: unknown; stopped_limit?: unknown };
      throwIfStreamError(ev);
      if (ev.stop === true) {
        // "limit": n_predict was reached ("eos" and "word" are normal stops). Older builds send `stopped_limit` instead.
        if (ev.stop_type === 'limit' || ev.stopped_limit === true) {
          req.onTruncated?.();
        }
        return;
      }
      if (typeof ev.content === 'string' && ev.content !== '') {
        yield ev.content;
      }
    }
  }
}
