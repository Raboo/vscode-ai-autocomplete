import type { BackendConfig } from '../types';
import { LlamaCppBackend } from './llamacpp';
import { inferHostFlavor } from './hostFlavor';
import { MistralBackend } from './mistral';
import { OpenAiCompatBackend } from './openaiCompat';
import { OpenRouterBackend } from './openrouter';
import type { ApiKeyProvider, FimBackend } from './types';

export function createBackend(cfg: BackendConfig, apiKey: ApiKeyProvider): FimBackend {
  switch (cfg.kind) {
    case 'llamacpp':
      return new LlamaCppBackend(cfg, apiKey);
    case 'openai':
      return inferHostFlavor(cfg) === 'openrouter' ? new OpenRouterBackend(cfg, apiKey) : new OpenAiCompatBackend(cfg, apiKey);
    case 'mistral':
      return new MistralBackend(cfg, apiKey);
  }
}
