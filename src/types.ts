export type BackendKind = 'llamacpp' | 'openai' | 'mistral';
export type HostFlavor = 'llamacpp' | 'vllm' | 'sglang' | 'lmstudio' | 'ollama' | 'strata' | 'deepseek' | 'fireworks' | 'together' | 'openrouter' | 'mistral' | 'generic';
export type FimMode = 'auto' | 'native' | 'template' | 'chat';
export type FimTemplateId = 'qwen' | 'codestral' | 'deepseek' | 'starcoder' | 'codellama' | 'codegemma' | 'granite-code' | 'granite4' | 'seed-coder' | 'mellum';

export type Multiline = 'auto' | 'always' | 'never';

/** Per-backend completion settings; every key is optional and overrides the global `aiAutocomplete.fim.*` value. */
export interface BackendFimSettings {
  template?: FimTemplateId; contextTokens?: number; prefixLines?: number; suffixLines?: number; extraContext?: boolean;
  multiline?: Multiline; maxTokens?: number; temperature?: number; topP?: number; topK?: number;
  debounceMs?: number; timeoutMs?: number; stop?: string[]; extraBody?: Record<string, unknown>;
}

export interface BackendConfig {
  id: string;
  kind: BackendKind;
  baseUrl: string;
  hostFlavor?: HostFlavor;
  fimModel?: string;
  nextEditModel?: string;
  fimMode: FimMode;
  headers: Record<string, string>;
  fim?: BackendFimSettings;
}

export interface Sampling {
  temperature?: number;
  topP?: number;
  topK?: number;
  maxTokens: number;
}

export interface ContextFile {
  path: string;
  text: string;
}

export interface ModelOverrideBody {
  fimTemplate?: FimTemplateId;
  stop?: string[];
  sampling?: Partial<Sampling>;
  extraBody?: Record<string, unknown>;
}
