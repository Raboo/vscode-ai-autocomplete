const MAX_BODY_TEXT = 500;

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly bodyText: string,
    readonly url: string,
  ) {
    super(`HTTP ${status} from ${url}`);
    this.name = 'HttpError';
  }
}

export interface PostOptions {
  headers?: Record<string, string>;
  signal: AbortSignal;
  timeoutMs: number;
}

export type ErrorClass = { kind: 'abort' } | { kind: 'http'; status: number } | { kind: 'network' };

/** POSTs JSON. Non-2xx responses throw an HttpError (body text truncated to 500 chars). */
export async function postJson(url: string, body: unknown, o: PostOptions): Promise<Response> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { ...o.headers, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.any([o.signal, AbortSignal.timeout(o.timeoutMs)]),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new HttpError(res.status, text.slice(0, MAX_BODY_TEXT), url);
  }
  return res;
}

export function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

export function classifyError(err: unknown): ErrorClass {
  const name = (err as { name?: unknown } | null)?.name;
  if (name === 'AbortError' || name === 'TimeoutError') {
    return { kind: 'abort' };
  }
  if (err instanceof HttpError) {
    return { kind: 'http', status: err.status };
  }
  return { kind: 'network' };
}
