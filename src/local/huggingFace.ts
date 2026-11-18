import { rename, rm } from 'node:fs/promises';
import { downloadModel, type DownloadOptions } from './download';
import { isSplitOrProjector, type LocalModel } from './modelList';

export type HfErrorKind = 'auth' | 'notFound' | 'http' | 'network';

const MESSAGES: Record<HfErrorKind, string> = {
  auth: 'This model needs a Hugging Face token, or access to the repo.',
  notFound: 'Hugging Face has no such repo or file.',
  http: 'Hugging Face answered with an error.',
  network: 'Could not reach Hugging Face.',
};

export class HfError extends Error {
  constructor(readonly kind: HfErrorKind) {
    super(MESSAGES[kind]);
    this.name = 'HfError';
  }
}

export interface HfOptions {
  token?: string;
  fetchFn?: typeof fetch;
  /** Defaults to https://huggingface.co; tests inject a loopback server. */
  apiBase?: string;
  signal?: AbortSignal;
}

export interface HfFile {
  path: string;
  bytes: number;
  sha256?: string;
  supported: boolean;
}

export type UpdateCheck =
  | { kind: 'upToDate' }
  | { kind: 'available'; revision: string; bytes: number; sha256: string; date?: string }
  | { kind: 'gone' };

const DEFAULT_BASE = 'https://huggingface.co';

/** The token goes only to https://huggingface.co, never to a CDN host or over http. */
export function tokenHeader(url: URL, token: string | undefined): Record<string, string> {
  if (token && url.protocol === 'https:' && url.hostname === 'huggingface.co') {
    return { Authorization: `Bearer ${token}` };
  }
  return {};
}

/** The `Authorization` value for a request to this URL (downloads ask per hop, so a redirect to a CDN drops it). */
export function authFor(token?: string): (u: URL) => string | undefined {
  return (u) => tokenHeader(u, token).Authorization;
}

export function pinnedFileUrl(repo: string, revision: string, file: string): string {
  return `${DEFAULT_BASE}/${repo}/resolve/${revision}/${file}`;
}

function authHeaders(url: URL, token: string | undefined): Record<string, string> {
  const auth = authFor(token)(url);
  return auth !== undefined ? { Authorization: auth } : {};
}

async function get(url: URL, o: HfOptions): Promise<Response> {
  let res: Response;
  try {
    res = await (o.fetchFn ?? fetch)(url, {
      headers: { accept: 'application/json', ...authHeaders(url, o.token) },
      signal: o.signal,
    });
  } catch {
    throw new HfError('network');
  }
  if (res.ok) return res;
  await res.body?.cancel().catch(() => undefined);
  if (res.status === 401 || res.status === 403) throw new HfError('auth');
  if (res.status === 404) throw new HfError('notFound');
  throw new HfError('http');
}

async function getJson(url: URL, o: HfOptions): Promise<{ body: unknown; next?: URL }> {
  const res = await get(url, o);
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new HfError('http');
  }
  const m = /<([^>]+)>\s*;\s*rel="next"/.exec(res.headers.get('link') ?? '');
  let next: URL | undefined;
  if (m) {
    try {
      next = new URL(m[1], url);
    } catch {
      next = undefined;
    }
  }
  return { body, next };
}

const apiUrl = (o: HfOptions, path: string): URL => new URL(path, o.apiBase ?? DEFAULT_BASE);
const encodeRepo = (repo: string): string => repo.split('/').map(encodeURIComponent).join('/');

async function repoInfo(repo: string, o: HfOptions): Promise<{ sha: string; date?: string }> {
  const { body } = await getJson(apiUrl(o, `/api/models/${encodeRepo(repo)}`), o);
  const b = body as { sha?: unknown; lastModified?: unknown } | null;
  if (!b || typeof b.sha !== 'string') throw new HfError('http');
  return { sha: b.sha, date: typeof b.lastModified === 'string' ? b.lastModified : undefined };
}

export async function repoCommit(repo: string, o: HfOptions): Promise<string> {
  return (await repoInfo(repo, o)).sha;
}

export async function ggufFiles(repo: string, revision: string, o: HfOptions): Promise<HfFile[]> {
  const out: HfFile[] = [];
  let url: URL | undefined = apiUrl(
    o,
    `/api/models/${encodeRepo(repo)}/tree/${encodeURIComponent(revision)}?recursive=true`,
  );
  for (let page = 0; url && page < 50; page++) {
    const { body, next } = await getJson(url, o);
    if (!Array.isArray(body)) throw new HfError('http');
    for (const e of body as Array<Record<string, unknown>>) {
      if (e.type !== 'file' || typeof e.path !== 'string' || !e.path.toLowerCase().endsWith('.gguf')) {
        continue;
      }
      const oid = (e.lfs as { oid?: unknown } | undefined)?.oid;
      const sha256 = typeof oid === 'string' ? oid : undefined;
      const f: HfFile = {
        path: e.path,
        bytes: typeof e.size === 'number' ? e.size : 0,
        supported: sha256 !== undefined && !isSplitOrProjector(e.path),
      };
      if (sha256) f.sha256 = sha256;
      out.push(f);
    }
    url = next;
  }
  return out;
}

/** Compares the repo's current commit with the pinned one; assumes an added (not built-in) model. */
export async function checkUpdate(m: LocalModel, o: HfOptions): Promise<UpdateCheck> {
  const info = await repoInfo(m.repo, o);
  if (info.sha === m.revision) return { kind: 'upToDate' };
  const file = (await ggufFiles(m.repo, info.sha, o)).find((f) => f.path === m.file);
  if (!file || !file.sha256) return { kind: 'gone' };
  const r: UpdateCheck = { kind: 'available', revision: info.sha, bytes: file.bytes, sha256: file.sha256 };
  if (info.date) r.date = info.date;
  return r;
}

export type UpdateOptions = Pick<
  DownloadOptions,
  'url' | 'bytes' | 'sha256' | 'signal' | 'onProgress' | 'authFor' | 'fetchFn' | 'freeBytes'
> & { dest: string };

/** Downloads to `<dest>.update`, then renames over `dest`; on failure `dest` stays untouched. */
export async function updateModelFile(o: UpdateOptions): Promise<void> {
  const tmp = `${o.dest}.update`;
  try {
    await downloadModel({ ...o, dest: tmp });
    await rename(tmp, o.dest);
  } catch (err) {
    await rm(tmp, { force: true });
    await rm(`${tmp}.part`, { force: true });
    throw err;
  }
}
