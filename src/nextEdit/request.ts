import type { ChatMessage, FimBackend } from '../backends/types';
import { chatRequestEnvelope } from '../completion/route';
import type { FimValues } from '../completion/effective';
import { ThinkingError } from '../completion/stream';
import { ReasoningFilter, startsWithThinkOpener } from '../models/thinking';
import type { HostFlavor } from '../types';
import { classify, isTrivialEdit, regionEdit, type LineEdit, type NextEditShow, type Pos } from './diff';
import type { ChatFormat, CompletionFormat, FormatAnswer, NextEditFormat, NextEditInput } from './formats/format';

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

interface RunOptions {
  backend: FimBackend;
  values: FimValues;
  flavor: HostFlavor;
  model: string | undefined;
  format: NextEditFormat;
  snapshot: NextEditSnapshot;
  rejected: ReadonlySet<string>;
  signal: AbortSignal;
  onRejected?(fields: string[]): void;
  /** Chat messages, or a completion format's prompt. */
  onPrompt?(prompt: ChatMessage[] | string): void;
  onAnswer?(visible: string): void;
}

/**
 * Runs one Next Edit request in the format's transport and decides how the answer is shown.
 * Resolves undefined for no change, an invalid, truncated or trivial answer. On the chat route, throws ThinkingError when
 * the model reasons (a reasoning event, or a think block with text at the start of the content). Throws the backend's
 * errors, a TimeoutError included.
 */
export async function runNextEdit(o: RunOptions): Promise<NextEditResult | undefined> {
  const answer = o.format.transport === 'chat' ? await chatAnswer(o, o.format) : await completionAnswer(o, o.format);
  return answer && resultOf(o.snapshot, answer);
}

/** Links an inner controller to the caller's signal; `done()` unlinks it. */
function linked(signal: AbortSignal): { ctl: AbortController; abort(): void; done(): void } {
  const ctl = new AbortController();
  const abort = (): void => ctl.abort();
  if (signal.aborted) abort();
  else signal.addEventListener('abort', abort, { once: true });
  return { ctl, abort, done: () => signal.removeEventListener('abort', abort) };
}

async function chatAnswer(o: RunOptions, format: ChatFormat): Promise<FormatAnswer> {
  const { input } = o.snapshot;
  const old = input.lines.slice(input.region.start, input.region.end + 1);
  let stableChars = 0;
  const { ctl, abort, done } = linked(o.signal);
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
      const m = format.messages(input, suffix);
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
      if (format.done(filter.visible)) break;
    }
  } catch (err) {
    abort();
    throw err;
  } finally {
    done();
  }
  if (!finished) filter.end();
  abort();
  const visible = filter.visible;
  o.onAnswer?.(visible);
  return format.parse(visible, true);
}

/** Undefined when the server stopped at the token limit: a cut-off answer is never used. */
async function completionAnswer(o: RunOptions, format: CompletionFormat): Promise<FormatAnswer | undefined> {
  const { input } = o.snapshot;
  const p = format.prompt(input);
  o.onPrompt?.(p.prompt);
  const { ctl, abort, done } = linked(o.signal);
  let truncated = false;
  let text = '';
  try {
    const chunks = o.backend.streamFim({
      ...(o.model ? { model: o.model } : {}),
      payload: { route: 'template', prompt: p.prompt },
      stop: p.stop,
      sampling: { temperature: 0, maxTokens: p.maxTokens },
      extraBody: o.values.extraBody,
      signal: ctl.signal,
      timeoutMs: o.values.timeoutMs,
      onTruncated: () => {
        truncated = true;
      },
    });
    for await (const chunk of chunks) text += chunk;
  } finally {
    abort();
    done();
  }
  let answer = p.prefill + text;
  // Some servers echo the stop string that ended the answer.
  const echoed = p.stop.find((s) => s !== '' && answer.endsWith(s));
  if (echoed) answer = answer.slice(0, answer.length - echoed.length);
  o.onAnswer?.(answer);
  return truncated ? undefined : format.parse(answer, input);
}

function resultOf(snapshot: NextEditSnapshot, answer: FormatAnswer): NextEditResult | undefined {
  const { input } = snapshot;
  if (answer.kind !== 'rewrite') return undefined;
  const old = input.lines.slice(input.region.start, input.region.end + 1);
  // An empty rewrite would propose deleting the whole region.
  if (answer.lines.length === 0 && old.some((l) => l.trim() !== '')) return undefined;
  const edit = regionEdit(old, answer.lines, input.region.start);
  if (!edit || isTrivialEdit(edit, input.lines)) return undefined;
  return {
    uri: snapshot.uri,
    version: snapshot.version,
    cursor: input.cursor,
    edit,
    show: classify(edit, input.lines, input.cursor),
  };
}
