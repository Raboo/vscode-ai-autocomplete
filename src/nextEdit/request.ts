import type { ChatMessage, FimBackend } from '../backends/types';
import { chatRequestEnvelope } from '../completion/route';
import type { FimValues } from '../completion/effective';
import { ThinkingError } from '../completion/stream';
import { ReasoningFilter, startsWithThinkOpener } from '../models/thinking';
import type { HostFlavor } from '../types';
import { classify, isTrivialEdit, regionEdit, type LineEdit, type NextEditShow, type Pos } from './diff';
import { chatXtabDone, chatXtabMessages, parseChatXtab, type NextEditInput } from './formats/chatXtab';

export interface NextEditSnapshot {
  uri: string;
  version: number;
  input: NextEditInput;
}

export interface NextEditResult {
  uri: string;
  version: number;
  cursor: Pos;
  edit: LineEdit;
  show: NextEditShow;
}

/** Room for a rewritten region (about 3.5 chars per token) with 50% slack and a small margin, at most 2048 tokens. */
export function nextEditMaxTokens(regionChars: number): number {
  return Math.min(2048, Math.ceil((regionChars / 3.5) * 1.5) + 64);
}

/**
 * Runs one Next Edit request on the backend's chat stream and decides how the answer is shown.
 * Resolves undefined for no change, an invalid, truncated or trivial answer. Throws ThinkingError when the model reasons
 * (a reasoning event, or a think block with text at the start of the content), and the backend's errors, a TimeoutError included.
 */
export async function runNextEdit(o: {
  backend: FimBackend;
  values: FimValues;
  flavor: HostFlavor;
  model: string | undefined;
  snapshot: NextEditSnapshot;
  rejected: ReadonlySet<string>;
  signal: AbortSignal;
  onRejected?(fields: string[]): void;
  onPrompt?(messages: ChatMessage[]): void;
  onAnswer?(visible: string): void;
}): Promise<NextEditResult | undefined> {
  const { input } = o.snapshot;
  const old = input.lines.slice(input.region.start, input.region.end + 1);
  let stableChars = 0;
  const ctl = new AbortController();
  const abort = (): void => ctl.abort();
  if (o.signal.aborted) abort();
  else o.signal.addEventListener('abort', abort, { once: true });
  const req = chatRequestEnvelope({
    values: o.values,
    flavor: o.flavor,
    model: o.model,
    rejected: o.rejected,
    signal: ctl.signal,
    ...(o.onRejected ? { onRejected: o.onRejected } : {}),
    maxTokens: nextEditMaxTokens(old.join('\n').length),
    stop: [],
    messages: (suffix) => {
      const m = chatXtabMessages(input, suffix);
      stableChars = m.stableChars;
      return m.messages;
    },
    pinChars: () => stableChars,
  });
  o.onPrompt?.(req.messages);

  const filter = new ReasoningFilter();
  let raw = '';
  let finished = false;
  try {
    for await (const ev of o.backend.streamChat(req)) {
      if (ev.type === 'reasoning') {
        filter.reasoning(ev.text);
        if (/\S/.test(ev.text)) throw new ThinkingError();
        continue;
      }
      if (ev.type === 'finish') {
        filter.end(ev.reason);
        finished = true;
        break;
      }
      filter.push(ev.text);
      raw += ev.text;
      if (filter.thinking && startsWithThinkOpener(raw)) throw new ThinkingError();
      if (chatXtabDone(filter.visible)) break;
    }
  } catch (err) {
    abort();
    throw err;
  } finally {
    o.signal.removeEventListener('abort', abort);
  }
  if (!finished) filter.end();
  abort();
  const visible = filter.visible;
  o.onAnswer?.(visible);

  const answer = parseChatXtab(visible, true);
  if (answer.kind !== 'rewrite') return undefined;
  // An empty fence body would propose deleting the whole region.
  if (answer.lines.length === 0 && old.some((l) => l.trim() !== '')) return undefined;
  const edit = regionEdit(old, answer.lines, input.region.start);
  if (!edit || isTrivialEdit(edit, input.lines)) return undefined;
  return {
    uri: o.snapshot.uri,
    version: o.snapshot.version,
    cursor: input.cursor,
    edit,
    show: classify(edit, input.lines, input.cursor),
  };
}
