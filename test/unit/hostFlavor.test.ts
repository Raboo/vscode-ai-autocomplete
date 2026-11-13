import { describe, expect, test } from 'vitest';
import { inferHostFlavor, isHostedFlavor } from '../../src/backends/hostFlavor';
import type { BackendConfig } from '../../src/types';

const cfg = (baseUrl: string, o: Partial<BackendConfig> = {}): BackendConfig => ({
  id: 'x',
  kind: 'openai',
  baseUrl,
  fimMode: 'auto',
  headers: {},
  ...o,
});

describe('inferHostFlavor', () => {
  test('explicit hostFlavor wins', () => {
    expect(inferHostFlavor(cfg('https://api.deepseek.com/v1', { hostFlavor: 'vllm' }))).toBe('vllm');
  });
  test.each([
    ['https://api.deepseek.com/v1', 'deepseek'],
    ['https://openrouter.ai/api/v1', 'openrouter'],
    ['https://api.fireworks.ai/inference/v1', 'fireworks'],
    ['https://api.together.xyz/v1', 'together'],
    ['http://localhost:11434/v1', 'ollama'],
    ['http://localhost:1234/v1', 'lmstudio'],
    ['http://localhost:9999/v1', 'generic'],
    ['not a url', 'generic'],
  ])('%s -> %s', (url, flavor) => {
    expect(inferHostFlavor(cfg(url))).toBe(flavor);
  });
  test('kind llamacpp and mistral', () => {
    expect(inferHostFlavor(cfg('http://localhost:1234', { kind: 'llamacpp' }))).toBe('llamacpp');
    expect(inferHostFlavor(cfg('https://api.mistral.ai/v1', { kind: 'mistral' }))).toBe('mistral');
  });
});

describe('isHostedFlavor', () => {
  test('self-hosted flavors are not hosted', () => {
    for (const f of ['llamacpp', 'vllm', 'sglang', 'lmstudio', 'ollama', 'strata'] as const) {
      expect(isHostedFlavor(f)).toBe(false);
    }
    for (const f of ['deepseek', 'fireworks', 'together', 'openrouter', 'mistral', 'generic'] as const) {
      expect(isHostedFlavor(f)).toBe(true);
    }
  });
});
