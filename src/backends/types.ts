import type { BackendConfig, ContextFile, Sampling } from '../types';

export type FimPayload =
  | {
      route: 'native';
      prefix: string;
      suffix: string;
      extra: ContextFile[];
      filePath: string;
      repoName: string;
    }
  | { route: 'template'; prompt: string };

export interface FimRequest {
  model?: string;
  payload: FimPayload;
  stop: string[];
  sampling: Sampling;
  timeMaxPredictMs?: number;
  extraBody: Record<string, unknown>;
  signal: AbortSignal;
  timeoutMs: number;
  /** Called at most once per stream when the server stopped at the token limit, so the answer is cut off. */
  onTruncated?(): void;
}

/** nativeChatModels: the native route also serves chat-family models (only DeepSeek's API). */
export interface RouteCaps {
  native: boolean;
  template: boolean;
  chat: boolean;
  nativeChatModels: boolean;
}

export interface ChatMessage {
  role: 'system' | 'user';
  content: string;
}

export interface ChatRequest {
  model?: string;
  messages: ChatMessage[];
  maxTokens: number;
  stop: string[];
  sampling: { temperature?: number; topP?: number; topK?: number; presencePenalty?: number };
  /** Merged into the body. */
  thinking: Record<string, unknown>;
  extraBody: Record<string, unknown>;
  signal: AbortSignal;
  timeoutMs: number;
  /** Called when a retry without these fields succeeded. */
  onRejected?(fields: string[]): void;
}

export type ChatEvent = { type: 'content'; text: string } | { type: 'reasoning'; text: string } | { type: 'finish'; reason: string };

export type ApiKeyProvider = () => Promise<string | undefined>;

export interface ServerInfo {
  models: string[];
  contextWindows: Record<string, number>;
  /** Models whose thinking cannot be turned off (filled by OpenRouter). */
  thinkingMandatory?: string[];
}

export const LIST_MODELS_TIMEOUT_MS = 2000;

export interface FimBackend {
  readonly config: BackendConfig;
  routes(): RouteCaps;
  detectModel(signal: AbortSignal): Promise<string | undefined>;
  /** Lists the server's models. Throws HttpError (any non-2xx, including 3xx) or the network/timeout error. */
  listModels(signal: AbortSignal, timeoutMs?: number): Promise<ServerInfo>;
  streamFim(req: FimRequest): AsyncIterable<string>;
  streamChat(req: ChatRequest): AsyncIterable<ChatEvent>;
}
