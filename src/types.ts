export type BackendKind = 'llamacpp' | 'openai' | 'mistral';
export type HostFlavor = 'llamacpp' | 'vllm' | 'sglang' | 'lmstudio' | 'ollama' | 'strata' | 'deepseek' | 'fireworks' | 'together' | 'openrouter' | 'mistral' | 'generic';
export type FimMode = 'auto' | 'native' | 'template' | 'chat';
export type FimTemplateId = 'qwen' | 'codestral' | 'deepseek' | 'starcoder' | 'codellama' | 'codegemma' | 'granite-code' | 'granite4' | 'seed-coder' | 'mellum';

export interface BackendConfig {
  id: string;
  kind: BackendKind;
  baseUrl: string;
  hostFlavor?: HostFlavor;
  fimModel?: string;
  nextEditModel?: string;
  fimMode: FimMode;
  headers: Record<string, string>;
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
