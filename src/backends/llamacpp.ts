import type { BackendConfig } from '../types';
import { authHeaders, getJson, joinUrl, postJson, throwIfStreamError } from './http';
import { parseSse } from './sse';
import { LIST_MODELS_TIMEOUT_MS, type ApiKeyProvider, type FimBackend, type FimRequest, type ServerInfo } from './types';

export class LlamaCppBackend implements FimBackend {
  constructor(
    readonly config: BackendConfig,
    private readonly apiKey: ApiKeyProvider,
  ) {}

  supportsNativeFim(): boolean {
    return true;
  }

  private async authHeaders(): Promise<Record<string, string>> {
    return authHeaders(this.config, await this.apiKey());
  }

  async listModels(signal: AbortSignal, timeoutMs = LIST_MODELS_TIMEOUT_MS): Promise<ServerInfo> {
    const props = (await getJson(joinUrl(this.config.baseUrl, '/props'), {
      headers: await this.authHeaders(),
      signal,
      timeoutMs,
    })) as { model_alias?: unknown; model_path?: unknown; n_ctx?: unknown; default_generation_settings?: { n_ctx?: unknown } } | null;
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

  async detectModel(signal: AbortSignal): Promise<string | undefined> {
    try {
      return (await this.listModels(signal)).models[0];
    } catch {
      return undefined;
    }
  }

  async *streamFim(req: FimRequest): AsyncGenerator<string> {
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
      const ev = JSON.parse(data) as { content?: unknown; stop?: unknown };
      throwIfStreamError(ev);
      if (ev.stop === true) {
        return;
      }
      if (typeof ev.content === 'string' && ev.content !== '') {
        yield ev.content;
      }
    }
  }
}
