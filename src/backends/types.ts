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
}

export type ApiKeyProvider = () => Promise<string | undefined>;

export interface ServerInfo {
  models: string[];
  contextWindows: Record<string, number>;
}

export const LIST_MODELS_TIMEOUT_MS = 2000;

export interface FimBackend {
  readonly config: BackendConfig;
  supportsNativeFim(): boolean;
  detectModel(signal: AbortSignal): Promise<string | undefined>;
  /** Lists the server's models. Throws HttpError (any non-2xx, including 3xx) or the network/timeout error. */
  listModels(signal: AbortSignal, timeoutMs?: number): Promise<ServerInfo>;
  streamFim(req: FimRequest): AsyncIterable<string>;
}
