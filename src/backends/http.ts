import type { BackendConfig } from '../types';

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

/** An error a server sent inside a stream it had answered with HTTP 200. The message is server text. */
export class StreamError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StreamError';
  }
}

/** Throws a StreamError when a parsed stream event has an `error` field, as OpenAI-compatible servers, llama.cpp and oMLX send one. */
export function throwIfStreamError(ev: unknown): void {
  const e = (ev as { error?: unknown } | null)?.error;
  if (e === undefined || e === null) return;
  const message = (e as { message?: unknown }).message;
  throw new StreamError(typeof e === 'string' ? e : typeof message === 'string' ? message : 'the server sent an error event');
}

export interface PostOptions {
  headers?: Record<string, string>;
  signal: AbortSignal;
  timeoutMs: number;
}

export interface GetOptions {
  headers?: Record<string, string>;
  signal: AbortSignal;
  timeoutMs: number;
}

export type ErrorClass = { kind: 'abort' } | { kind: 'http'; status: number } | { kind: 'network' };

/**
 * POSTs JSON. Non-2xx responses throw an HttpError (body text truncated to 500 chars). Redirects are not
 * followed (a 3xx is an HttpError), so code never goes to a host other than the configured one.
 */
export async function postJson(url: string, body: unknown, o: PostOptions): Promise<Response> {
  const res = await fetch(url, {
    method: 'POST',
    // A user Content-Type in another case would be sent alongside ours: the body is always JSON.
    headers: { ...withoutContentType(o.headers), 'content-type': 'application/json' },
    body: JSON.stringify(body),
    redirect: 'manual',
    signal: AbortSignal.any([o.signal, AbortSignal.timeout(o.timeoutMs)]),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new HttpError(res.status, text.slice(0, MAX_BODY_TEXT), url);
  }
  return res;
}

function withoutContentType(headers: Record<string, string> | undefined): Record<string, string> {
  return Object.fromEntries(Object.entries(headers ?? {}).filter(([k]) => k.toLowerCase() !== 'content-type'));
}

/** GETs JSON. Same error contract as postJson: non-2xx (including an unfollowed 3xx) throws an HttpError. */
export async function getJson(url: string, o: GetOptions): Promise<unknown> {
  const res = await fetch(url, {
    method: 'GET',
    headers: o.headers,
    redirect: 'manual',
    signal: AbortSignal.any([o.signal, AbortSignal.timeout(o.timeoutMs)]),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new HttpError(res.status, text.slice(0, MAX_BODY_TEXT), url);
  }
  return res.json();
}

export function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

export function classifyError(err: unknown): ErrorClass {
  const name = (err as { name?: unknown } | null)?.name;
  if (name === 'AbortError') {
    return { kind: 'abort' };
  }
  // A timeout means the backend is unresponsive, so it counts as a failure (not a user cancel).
  if (name === 'TimeoutError') {
    return { kind: 'network' };
  }
  if (err instanceof HttpError) {
    return { kind: 'http', status: err.status };
  }
  return { kind: 'network' };
}

/** True when the headers hold an Authorization header, in any letter case. */
export function hasAuthorizationHeader(headers: Record<string, string> | undefined): boolean {
  return Object.keys(headers ?? {}).some((k) => k.toLowerCase() === 'authorization');
}

/** Request headers for a backend: config headers plus a bearer token when a key is set; the user's own Authorization header wins over the key. */
export function authHeaders(config: BackendConfig, key: string | undefined): Record<string, string> {
  return { ...config.headers, ...(key && !hasAuthorizationHeader(config.headers) ? { authorization: `Bearer ${key}` } : {}) };
}
