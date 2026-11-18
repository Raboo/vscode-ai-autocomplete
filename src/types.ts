export type BackendKind = 'llamacpp' | 'openai' | 'mistral';
export type HostFlavor = 'llamacpp' | 'vllm' | 'sglang' | 'lmstudio' | 'ollama' | 'strata' | 'deepseek' | 'fireworks' | 'together' | 'openrouter' | 'mistral' | 'generic';
export type FimMode = 'auto' | 'native' | 'template' | 'chat';
export type FimTemplateId = 'qwen' | 'codestral' | 'deepseek' | 'starcoder' | 'codellama' | 'codegemma' | 'granite-code' | 'granite4' | 'seed-coder' | 'mellum';

export type Multiline = 'auto' | 'always' | 'never';

/** How thinking is turned off for a model on the chat prompt; `thinkingFields` (models/thinking.ts) turns each id into request fields. */
export type ThinkingStrategy = 'none' | 'templateKwarg:enable_thinking' | 'templateKwarg:thinking' | 'templateKwarg:thinking_mode=disabled'
  | 'templateKwarg:thinking_budget=0' | 'reasoningEffortNone' | 'systemSoftSwitch:/no_think' | 'vendorThinkingDisabled' | 'cannotDisable';

/** Per-backend completion settings; every key is optional and overrides the global `aiAutocomplete.completions.*` value. */
export interface BackendFimSettings {
  template?: FimTemplateId; contextTokens?: number; prefixLines?: number; suffixLines?: number; extraContext?: boolean;
  multiline?: Multiline; maxTokens?: number; temperature?: number; topP?: number; topK?: number;
  debounceMs?: number; timeoutMs?: number; stop?: string[]; extraBody?: Record<string, unknown>;
  thinking?: ThinkingStrategy;
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
  /** What the backend is used for; missing in the setting means both. */
  use: { completions: boolean; nextEdit: boolean };
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
  thinking?: ThinkingStrategy;
}
