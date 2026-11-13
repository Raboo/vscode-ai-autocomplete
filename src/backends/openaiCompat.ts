import type { BackendConfig, HostFlavor } from '../types';
import { inferHostFlavor, isHostedFlavor } from './hostFlavor';
import { authHeaders, joinUrl, postJson } from './http';
import { parseSse } from './sse';
import type { ApiKeyProvider, FimBackend, FimRequest } from './types';

const DETECT_TIMEOUT_MS = 2000;
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

  async detectModel(signal: AbortSignal): Promise<string | undefined> {
    try {
      const res = await fetch(joinUrl(this.config.baseUrl, 'models'), {
        headers: await this.headers(),
        signal: AbortSignal.any([signal, AbortSignal.timeout(DETECT_TIMEOUT_MS)]),
      });
      if (!res.ok) {
        return undefined;
      }
      const { data } = (await res.json()) as { data?: { id?: unknown }[] };
      if (!Array.isArray(data) || data.length !== 1) {
        return undefined;
      }
      const id = data[0]?.id;
      return typeof id === 'string' && id ? id : undefined;
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
      const text = ev.choices?.[0]?.text;
      if (typeof text === 'string' && text !== '') {
        yield text;
      }
    }
  }
}
