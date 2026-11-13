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

export interface FimBackend {
  readonly config: BackendConfig;
  supportsNativeFim(): boolean;
  detectModel(signal: AbortSignal): Promise<string | undefined>;
  streamFim(req: FimRequest): AsyncIterable<string>;
}
