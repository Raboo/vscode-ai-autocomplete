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

export function inferHostFlavor(cfg: BackendConfig): HostFlavor {
  if (cfg.hostFlavor) {
    return cfg.hostFlavor;
  }
  if (cfg.kind === 'llamacpp') {
    return 'llamacpp';
  }
  if (cfg.kind === 'mistral') {
    return 'mistral';
  }
  let url: URL;
  try {
    url = new URL(cfg.baseUrl);
  } catch {
    return 'generic';
  }
  const host = url.hostname.toLowerCase();
  for (const [name, flavor] of HOSTNAME_FLAVORS) {
    if (host === name) {
      return flavor;
    }
  }
  if (url.port === '11434') {
    return 'ollama';
  }
  if (url.port === '1234') {
    return 'lmstudio';
  }
  return 'generic';
}
