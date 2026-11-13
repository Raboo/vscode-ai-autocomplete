import { inferHostFlavor } from '../backends/hostFlavor';
import type { BackendKind, HostFlavor } from '../types';
import type { ServerTypeId } from './protocol';

export interface ServerType {
  id: ServerTypeId; label: string; kind: BackendKind; hostFlavor?: HostFlavor; defaultUrl: string; defaultModel?: string; key: 'no' | 'optional' | 'yes';
}

export const SERVER_TYPES: readonly ServerType[] = [
  { id: 'llamacpp', label: 'llama.cpp', kind: 'llamacpp', defaultUrl: 'http://127.0.0.1:8012', key: 'no' },
  { id: 'lmstudio', label: 'LM Studio', kind: 'openai', hostFlavor: 'lmstudio', defaultUrl: 'http://127.0.0.1:1234/v1', key: 'no' },
  { id: 'ollama', label: 'Ollama', kind: 'openai', hostFlavor: 'ollama', defaultUrl: 'http://127.0.0.1:11434/v1', key: 'no' },
  { id: 'vllm', label: 'vLLM', kind: 'openai', hostFlavor: 'vllm', defaultUrl: 'http://127.0.0.1:8000/v1', key: 'optional' },
  { id: 'sglang', label: 'SGLang', kind: 'openai', hostFlavor: 'sglang', defaultUrl: 'http://127.0.0.1:30000/v1', key: 'optional' },
  { id: 'mistral', label: 'Mistral Codestral', kind: 'mistral', defaultUrl: 'https://codestral.mistral.ai', defaultModel: 'codestral-latest', key: 'yes' },
  { id: 'deepseek', label: 'DeepSeek', kind: 'openai', hostFlavor: 'deepseek', defaultUrl: 'https://api.deepseek.com/beta', key: 'yes' },
  { id: 'fireworks', label: 'Fireworks', kind: 'openai', hostFlavor: 'fireworks', defaultUrl: 'https://api.fireworks.ai/inference/v1', key: 'yes' },
  { id: 'together', label: 'Together', kind: 'openai', hostFlavor: 'together', defaultUrl: 'https://api.together.xyz/v1', key: 'yes' },
  { id: 'other', label: 'Other OpenAI-compatible', kind: 'openai', hostFlavor: 'generic', defaultUrl: '', key: 'optional' },
];

export function serverTypeOf(cfg: { kind: BackendKind; hostFlavor?: HostFlavor; baseUrl: string }): ServerTypeId {
  const flavor = inferHostFlavor({ ...cfg, id: '', fimMode: 'auto', headers: {} });
  for (const t of SERVER_TYPES) {
    if (t.kind === cfg.kind && inferHostFlavor({ id: '', kind: t.kind, ...(t.hostFlavor ? { hostFlavor: t.hostFlavor } : {}), baseUrl: '', fimMode: 'auto', headers: {} }) === flavor) return t.id;
  }
  return 'other';
}

export function suggestId(type: ServerTypeId, taken: readonly string[]): string {
  const base = type === 'mistral' ? 'codestral' : type === 'other' ? 'openai' : type;
  if (!taken.includes(base)) return base;
  for (let n = 2; ; n++) if (!taken.includes(`${base}-${n}`)) return `${base}-${n}`;
}
