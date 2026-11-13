import { codestralPrefix } from '../models/templates';
import type { BackendConfig } from '../types';
import { authHeaders, HttpError, joinUrl, postJson } from './http';
import { parseSse } from './sse';
import type { ApiKeyProvider, FimBackend, FimRequest } from './types';

const CODESTRAL_HOST = 'codestral.mistral.ai';
const API_HOST = 'api.mistral.ai';
const DEFAULT_BASE = `https://${CODESTRAL_HOST}`;
const DEFAULT_MODEL = 'codestral-latest';

export class MissingApiKeyError extends Error {
  constructor(readonly backendId: string) {
    super(`No API key set for backend "${backendId}"`);
    this.name = 'MissingApiKeyError';
  }
}

export interface MistralOptions {
  /** Test seam: maps a logical base URL (e.g. https://api.mistral.ai) to the URL actually called. */
  resolveBase?: (base: string) => string;
}

function otherMistralBase(base: string): string | undefined {
  let host: string;
  try {
    host = new URL(base).hostname;
  } catch {
    return undefined;
  }
  if (host === CODESTRAL_HOST) {
    return `https://${API_HOST}`;
  }
  if (host === API_HOST) {
    return `https://${CODESTRAL_HOST}`;
  }
  return undefined;
}

export class MistralBackend implements FimBackend {
  /** Base URL that last worked (or the configured one until a fallback succeeds). */
  private base: string;
  private readonly resolveBase: (base: string) => string;

  constructor(
    readonly config: BackendConfig,
    private readonly apiKey: ApiKeyProvider,
    opts: MistralOptions = {},
  ) {
    this.base = config.baseUrl || DEFAULT_BASE;
    this.resolveBase = opts.resolveBase ?? ((b) => b);
  }

  supportsNativeFim(): boolean {
    return true;
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- interface signature; no network probe for a hosted API
  async detectModel(_signal: AbortSignal): Promise<string | undefined> {
    return this.config.fimModel ?? DEFAULT_MODEL;
  }

  private post(base: string, body: unknown, headers: Record<string, string>, req: FimRequest): Promise<Response> {
    return postJson(joinUrl(this.resolveBase(base), 'v1/fim/completions'), body, {
      headers,
      signal: req.signal,
      timeoutMs: req.timeoutMs,
    });
  }

  async *streamFim(req: FimRequest): AsyncGenerator<string> {
    const { payload, sampling } = req;
    if (payload.route !== 'native') {
      throw new Error('Mistral FIM is native only (template route unsupported)');
    }
    const key = await this.apiKey();
    if (!key) {
      throw new MissingApiKeyError(this.config.id);
    }
    // Mistral rejects requests carrying both temperature and top_p.
    const sendTopP = sampling.topP !== undefined && sampling.temperature === undefined;
    const body = {
      model: req.model ?? this.config.fimModel ?? DEFAULT_MODEL,
      prompt: codestralPrefix(payload),
      suffix: payload.suffix,
      max_tokens: sampling.maxTokens,
      ...(sampling.temperature !== undefined ? { temperature: sampling.temperature } : {}),
      ...(sendTopP ? { top_p: sampling.topP } : {}),
      ...(req.stop.length > 0 ? { stop: req.stop } : {}),
      stream: true,
      ...req.extraBody,
    };
    const headers = authHeaders(this.config, key);

    let res: Response;
    try {
      res = await this.post(this.base, body, headers, req);
    } catch (err) {
      const alt = err instanceof HttpError && (err.status === 401 || err.status === 403) ? otherMistralBase(this.base) : undefined;
      if (!alt) {
        throw err;
      }
      res = await this.post(alt, body, headers, req);
      this.base = alt;
    }
    if (!res.body) {
      return;
    }
    for await (const data of parseSse(res.body)) {
      if (data === '') {
        continue;
      }
      const ev = JSON.parse(data) as {
        choices?: { delta?: { content?: unknown }; message?: { content?: unknown }; text?: unknown }[];
      };
      const c = ev.choices?.[0];
      const text = c?.delta?.content ?? c?.message?.content ?? c?.text;
      if (typeof text === 'string' && text !== '') {
        yield text;
      }
    }
  }
}
