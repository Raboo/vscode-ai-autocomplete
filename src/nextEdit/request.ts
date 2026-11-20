import type { ChatMessage, FimBackend } from '../backends/types';
import { chatRequestEnvelope } from '../completion/route';
import type { FimValues } from '../completion/effective';
import { ThinkingError } from '../completion/stream';
import { ReasoningFilter, startsWithThinkOpener } from '../models/thinking';
import type { HostFlavor } from '../types';
import { classify, cursorWithin, isTrivialEdit, regionEdit, type LineEdit, type NextEditShow, type Pos } from './diff';
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
  /** Where the model predicts the cursor after the edit, in the document once it is applied; only on the edit's new lines. */
  cursorAfter?: Pos;
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
  /** A completion format's answer was cut at max_tokens and is dropped. */
  onTruncated?(): void;
  /** The parsed answer, before it becomes a result; not called for a truncated answer. */
  onParsed?(answer: FormatAnswer): void;
}

/**
 * Runs one Next Edit request in the format's transport and decides how the answer is shown.
 * Resolves undefined for no change, an invalid, truncated or trivial answer. On the chat route, throws ThinkingError when
 * the model reasons (a reasoning event, or a think block with text at the start of the content). Throws the backend's
 * errors, a TimeoutError included.
 */
export async function runNextEdit(o: RunOptions): Promise<NextEditResult | undefined> {
  const answer = o.format.transport === 'chat' ? await chatAnswer(o, o.format) : await completionAnswer(o, o.format);
  if (!answer) return undefined;
  o.onParsed?.(answer);
  return resultOf(o.snapshot, answer);
}

/**
 * Warms the Next Edit slot: the format's prompt with no tokens to generate, so llama.cpp only fills its prompt cache.
 * The answer is drained and ignored. Raw formats only. Throws the backend's errors.
 */
export async function warmNextEdit(o: { backend: FimBackend; values: FimValues; model: string | undefined; format: CompletionFormat; input: NextEditInput; signal: AbortSignal }): Promise<void> {
  const p = o.format.prompt(o.input);
  const chunks = o.backend.streamFim({
    ...(o.model ? { model: o.model } : {}),
    payload: { route: 'template', prompt: p.prompt },
    slot: 'nextEdit',
    stop: p.stop,
    sampling: { temperature: 0, maxTokens: 0 },
    extraBody: o.values.extraBody,
    signal: o.signal,
    timeoutMs: o.values.timeoutMs,
  });
  for await (const chunk of chunks) void chunk;
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

  // The controller never asks a model that may think (`thinkingBlocked`), so a bare closing tag is answer text.
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
      slot: 'nextEdit',
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
  if (truncated) {
    o.onTruncated?.();
    return undefined;
  }
  return format.parse(answer, input);
}

function resultOf(snapshot: NextEditSnapshot, answer: FormatAnswer): NextEditResult | undefined {
  const { input } = snapshot;
  if (answer.kind !== 'rewrite') return undefined;
  const old = input.lines.slice(input.region.start, input.region.end + 1);
  // An empty rewrite would propose deleting the whole region.
  if (answer.lines.length === 0 && old.some((l) => l.trim() !== '')) return undefined;
  const lines = [...answer.lines];
  // A region that ends at the file's final newline keeps it, also when the answer drops the blank last line.
  if (input.region.end === input.lines.length - 1 && old.at(-1) === '' && lines.at(-1) !== '') lines.push('');
  const edit = regionEdit(old, lines, input.region.start);
  if (!edit || isTrivialEdit(edit, input.lines)) return undefined;
  const predicted = answer.cursor && { line: input.region.start + answer.cursor.line, character: answer.cursor.character };
  const cursorAfter = cursorWithin(edit, predicted);
  return {
    uri: snapshot.uri,
    version: snapshot.version,
    cursor: input.cursor,
    edit,
    show: classify(edit, input.lines, input.cursor),
    ...(cursorAfter ? { cursorAfter } : {}),
  };
}
