// Message and view types shared by the extension host and the Backends page script. A leaf module: no imports.

export type ServerTypeId = 'llamacpp' | 'lmstudio' | 'ollama' | 'vllm' | 'sglang' | 'mistral' | 'deepseek' | 'fireworks' | 'together' | 'other';
export type FormField = 'template' | 'fimMode' | 'multiline' | 'contextTokens' | 'prefixLines' | 'suffixLines' | 'extraContext'
  | 'temperature' | 'topP' | 'topK' | 'maxTokens' | 'debounceMs' | 'timeoutMs' | 'stop' | 'headers' | 'extraBody';

/** The form never carries an API key; the key travels separately in page→host messages only. */
export interface BackendForm {
  originalId?: string;
  type: ServerTypeId;
  id: string;
  baseUrl: string;
  /** '' = auto-detect. */
  model: string;
  /** Text as typed; a checkbox is 'true' or 'false'. */
  changed: Partial<Record<FormField, string>>;
}

export type StepId = 'reach' | 'model' | 'completion' | 'context';
export interface TestStep { id: StepId; state: 'ok' | 'warn' | 'fail'; text: string; hint?: string; ms?: number }
export interface FieldView {
  field: FormField; label: string; value: string; isDefault: boolean; hint: string;
  options?: string[]; disabledReason?: string; error?: string;
}
export type Dot = 'grey' | 'green' | 'yellow' | 'red' | 'lock';
export interface CardView {
  id: string; typeLabel: string; baseUrl: string; model?: string; modelDetected: boolean; inUse: boolean; keyStored: boolean;
  warning?: string; dot: Dot; test?: TestStep[];
}
export interface EditView {
  cardId: string | null; form: BackendForm; keyMode: 'no' | 'optional' | 'yes'; keyStored: boolean; fields: FieldView[];
  models?: { id: string; ready: boolean }[]; modelsError?: string; errors: { field: string; message: string }[]; warnings: string[];
  testing: boolean; test?: TestStep[];
}
export interface PageState { completionsOn: boolean; localOnly: boolean; cards: CardView[]; edit?: EditView; serverTypes: { id: ServerTypeId; label: string }[] }

export type HostMessage = { type: 'state'; state: PageState };
export type PageMessage =
  | { type: 'ready' } | { type: 'add' } | { type: 'edit'; id: string } | { type: 'cancel' } | { type: 'formChanged'; form: BackendForm }
  | { type: 'save'; form: BackendForm; apiKey?: string } | { type: 'remove'; id: string } | { type: 'use'; id: string } | { type: 'test'; id: string }
  | { type: 'testForm'; form: BackendForm; apiKey?: string } | { type: 'reloadModels'; form: BackendForm; apiKey?: string }
  | { type: 'removeKey'; id: string } | { type: 'openSettings' };
