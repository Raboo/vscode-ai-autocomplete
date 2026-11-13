import { promises as dns } from 'node:dns';
import { isIPv4, isIPv6 } from 'node:net';

function v4Private(ip: string): boolean {
  const [a, b] = ip.split('.').map(Number);
  return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
}

export function isPrivateAddress(ip: string): boolean {
  const addr = ip.toLowerCase();
  if (isIPv4(addr)) return v4Private(addr);
  if (!isIPv6(addr)) return false;
  // v4-mapped in dotted form (::ffff:a.b.c.d)
  const dotted = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(addr);
  if (dotted) return v4Private(dotted[1]);
  // v4-mapped in hex form (::ffff:c0a8:0002)
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(addr);
  if (hex) {
    const hi = parseInt(hex[1], 16);
    const lo = parseInt(hex[2], 16);
    return v4Private(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  }
  if (addr === '::1') return true;
  const first = addr.split(':')[0];
  if (first === '') return false;
  const word = parseInt(first, 16);
  if (Number.isNaN(word)) return false;
  return (word & 0xfe00) === 0xfc00 || (word & 0xffc0) === 0xfe80;
}

type Lookup = (host: string) => Promise<string[]>;

const defaultLookup: Lookup = async (host) => (await dns.lookup(host, { all: true })).map((r) => r.address);

export async function isLocalEndpoint(baseUrl: string, lookup: Lookup = defaultLookup): Promise<boolean> {
  let host: string;
  try {
    host = new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  if (host.endsWith('.')) host = host.slice(0, -1);
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (isIPv4(host) || isIPv6(host)) return isPrivateAddress(host);
  try {
    const addrs = await lookup(host);
    return addrs.length > 0 && addrs.every(isPrivateAddress);
  } catch {
    return false;
  }
}

/** Caches an async per-baseUrl check for ttlMs (the answer may need a DNS lookup). */
export function memoizeIsLocal(fn: (baseUrl: string) => Promise<boolean>, ttlMs: number, now: () => number = Date.now): ((baseUrl: string) => Promise<boolean>) & { clear(): void } {
  const memo = new Map<string, { at: number; value: Promise<boolean> }>();
  const call = (baseUrl: string): Promise<boolean> => {
    const hit = memo.get(baseUrl);
    if (hit && now() - hit.at < ttlMs) return hit.value;
    const value = fn(baseUrl);
    memo.set(baseUrl, { at: now(), value });
    return value;
  };
  call.clear = (): void => memo.clear();
  return call;
}

/** Synchronous, DNS-free guess: localhost, *.localhost or a private IP literal. */
export function isObviouslyLocal(baseUrl: string): boolean {
  let host: string;
  try {
    host = new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  if (host.endsWith('.')) host = host.slice(0, -1);
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  return (isIPv4(host) || isIPv6(host)) && isPrivateAddress(host);
}
