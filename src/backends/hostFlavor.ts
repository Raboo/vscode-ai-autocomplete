import type { BackendConfig, HostFlavor } from '../types';

const SELF_HOSTED: ReadonlySet<HostFlavor> = new Set(['llamacpp', 'vllm', 'sglang', 'lmstudio', 'ollama', 'strata']);

const HOSTNAME_FLAVORS: readonly [string, HostFlavor][] = [
  ['api.deepseek.com', 'deepseek'],
  ['openrouter.ai', 'openrouter'],
  ['api.fireworks.ai', 'fireworks'],
  ['api.together.xyz', 'together'],
];

export function isHostedFlavor(f: HostFlavor): boolean {
  return !SELF_HOSTED.has(f);
}

function parseUrl(baseUrl: string): URL | undefined {
  try {
    return new URL(baseUrl);
  } catch {
    return undefined;
  }
}

function hostnameFlavor(url: URL): HostFlavor | undefined {
  const host = url.hostname.toLowerCase();
  return HOSTNAME_FLAVORS.find(([name]) => host === name)?.[1];
}

/**
 * An explicit hostFlavor wins, except `generic` on a known hosted hostname: "Other OpenAI-compatible" pointed at
 * openrouter.ai still gets OpenRouter's rules (chat only, no code to its undocumented completions endpoint).
 */
export function inferHostFlavor(cfg: BackendConfig): HostFlavor {
  const url = parseUrl(cfg.baseUrl);
  if (cfg.hostFlavor === 'generic') {
    return (url && hostnameFlavor(url)) ?? 'generic';
  }
  if (cfg.hostFlavor) {
    return cfg.hostFlavor;
  }
  if (cfg.kind === 'llamacpp') {
    return 'llamacpp';
  }
  if (cfg.kind === 'mistral') {
    return 'mistral';
  }
  if (!url) {
    return 'generic';
  }
  const byHost = hostnameFlavor(url);
  if (byHost) {
    return byHost;
  }
  if (url.port === '11434') {
    return 'ollama';
  }
  if (url.port === '1234') {
    return 'lmstudio';
  }
  return 'generic';
}
