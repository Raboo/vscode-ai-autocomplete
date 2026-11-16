// Message and view types shared by the extension host and the Backends page script. A leaf module: no imports.

export type ServerTypeId = 'llamacpp' | 'lmstudio' | 'ollama' | 'vllm' | 'sglang' | 'strata' | 'mistral' | 'deepseek' | 'fireworks' | 'together' | 'openrouter' | 'other';
export type FormField = 'template' | 'fimMode' | 'thinking' | 'multiline' | 'contextTokens' | 'prefixLines' | 'suffixLines' | 'extraContext'
  | 'temperature' | 'topP' | 'topK' | 'maxTokens' | 'debounceMs' | 'timeoutMs' | 'stop' | 'headers' | 'extraBody';
/** The controls a validation error can point at. */
export type ErrorField = FormField | 'id' | 'baseUrl' | 'use';

/** The form never carries an API key; the key travels separately in page→host messages only. */
export interface BackendForm {
  originalId?: string;
  type: ServerTypeId;
  id: string;
  baseUrl: string;
  /** '' = auto-detect. */
  model: string;
  /** '' = the completion model. */
  nextEditModel: string;
  /** What the backend is used for; at least one must be ticked to save. */
  use: { completions: boolean; nextEdit: boolean };
  /** Text as typed; a checkbox is 'true' or 'false'. */
  changed: Partial<Record<FormField, string>>;
}

export type StepId = 'reach' | 'model' | 'completion' | 'thinking' | 'context';
export interface TestStep { id: StepId; state: 'ok' | 'warn' | 'fail'; text: string; hint?: string; ms?: number }
export interface FieldView {
  field: FormField; label: string; value: string; isDefault: boolean; hint: string;
  options?: string[];
  /** value → label, for the option text when the value is not readable. */
  optionLabels?: Record<string, string>;
  disabledReason?: string; error?: string;
}
export type Dot = 'grey' | 'green' | 'yellow' | 'red' | 'lock';
export interface CardView {
  id: string; typeLabel: string; baseUrl: string;
  /** The completion model; none for a backend not used for completions. */
  model?: string; modelDetected: boolean;
  /** The Next Edit model (configured, or the completion model, or the detected one); none for a backend not used for Next Edit. */
  nextEditModel?: string;
  uses: { completions: boolean; nextEdit: boolean };
  inUse: boolean; nextEditInUse: boolean; keyStored: boolean;
  warning?: string; dot: Dot; test?: TestStep[];
}
export interface EditView {
  cardId: string | null; form: BackendForm; keyMode: 'no' | 'optional' | 'yes'; keyStored: boolean; fields: FieldView[];
  /** `tag` is "ready", "chat prompt" (with ", cannot turn thinking off" for a model that cannot do so), or why the backend has no route for that model. */
  models?: { id: string; tag: string }[]; modelsError?: string; errors: { field: ErrorField; message: string }[]; warnings: string[];
  /** The format the Next Edit model will use ("Zeta 2.1 format", "Sweep v1 format", "Sweep v2 format" or "chat prompt (chatXtab)"); none when the backend is not used for Next Edit. */
  nextEditFormat?: string;
  testing: boolean; test?: TestStep[];
}
export interface PageState { completionsOn: boolean; localOnly: boolean; cards: CardView[]; edit?: EditView; serverTypes: { id: ServerTypeId; label: string }[] }

export type HostMessage = { type: 'state'; state: PageState };
export type PageMessage =
  | { type: 'ready' } | { type: 'add' } | { type: 'edit'; id: string } | { type: 'cancel' } | { type: 'formChanged'; form: BackendForm }
  | { type: 'save'; form: BackendForm; apiKey?: string } | { type: 'remove'; id: string } | { type: 'use'; id: string } | { type: 'useNextEdit'; id: string } | { type: 'test'; id: string }
  | { type: 'testForm'; form: BackendForm; apiKey?: string } | { type: 'reloadModels'; form: BackendForm; apiKey?: string }
  | { type: 'removeKey'; id: string } | { type: 'openSettings' };
