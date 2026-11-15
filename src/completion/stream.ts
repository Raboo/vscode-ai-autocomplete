import type { ChatEvent, ChatRequest, FimBackend, FimRequest } from '../backends/types';
import { ReasoningFilter } from '../models/thinking';
import type { CompletionAccumulator } from './filters';
import { HoleFillerAnswer } from './holeFiller';

export type PlannedRequest =
  | { route: 'native' | 'template'; req: FimRequest }
  | { route: 'chat'; req: ChatRequest; linePrefix: string };

export interface Collected { text: string; stoppedEarly: boolean; thinking: boolean; timedOut: boolean; /** Chat route: the visible model output before answer extraction. */ visible?: string }

/** The model reasoned although thinking was asked off, and the caller asked to fail on it (`failOnThinking`). */
export class ThinkingError extends Error {
  constructor() {
    super('the model is thinking');
    this.name = 'ThinkingError';
  }
}

const isTimeout = (err: unknown): boolean => (err as { name?: unknown } | null)?.name === 'TimeoutError';

/** The chat route's parsing state, kept outside the stream loop so a timeout can settle from it. */
interface ChatState { filter: ReasoningFilter; answer: HoleFillerAnswer }

/**
 * Streams one request into `acc` and returns `acc.text`. FIM routes push chunks as today (postprocess strips a leading reasoning block later).
 * The chat route feeds ReasoningFilter → HoleFillerAnswer → acc.replace(answer). When `acc` stops early, `ctl.abort()` ends the stream.
 * Throws the backend's error, except a TimeoutError after at least one complete line: those lines come back with timedOut true.
 * With `failOnThinking`, the first reasoning text (a reasoning event, or a think block with text in the content) aborts `ctl`
 * and throws ThinkingError; an empty think block (the prefill of a thinking-off template) is not reasoning.
 */
export async function collectCompletion(
  backend: FimBackend,
  p: PlannedRequest,
  acc: CompletionAccumulator,
  ctl: AbortController,
  opts: { failOnThinking?: boolean } = {},
): Promise<Collected> {
  let stopped = false;
  let chat: ChatState | undefined;
  try {
    if (p.route === 'chat') {
      chat = { filter: new ReasoningFilter(), answer: new HoleFillerAnswer(p.linePrefix) };
      stopped = await collectChat(backend.streamChat(p.req), chat, acc, ctl, opts.failOnThinking === true);
    } else {
      for await (const chunk of backend.streamFim(p.req)) {
        if (acc.push(chunk)) {
          stopped = true;
          ctl.abort();
          break;
        }
      }
    }
  } catch (err) {
    if (!isTimeout(err)) throw err;
    // `acc` may still hold an answer fed before a bare closing tag: settle from what the filter shows now.
    if (chat) acc.replace(chat.answer.update(chat.filter.visible, false));
    const text = acc.text;
    const nl = text.lastIndexOf('\n');
    if (nl < 0) throw err;
    return { text: text.slice(0, nl), stoppedEarly: stopped, ...seen(chat), timedOut: true };
  }
  return { text: acc.text, stoppedEarly: stopped, ...seen(chat), timedOut: false };
}

function seen(chat: ChatState | undefined): { thinking: boolean; visible?: string } {
  return chat ? { thinking: chat.filter.thinking, visible: chat.filter.visible } : { thinking: false };
}

async function collectChat(events: AsyncIterable<ChatEvent>, { filter, answer }: ChatState, acc: CompletionAccumulator, ctl: AbortController, failOnThinking: boolean): Promise<boolean> {
  // Only answers that extend the previous one reach `acc`: a shorter one (visible shrank on a bare closing tag) waits for the end.
  let fed = '';
  let finished = false;
  for await (const ev of events) {
    if (ev.type === 'reasoning') {
      filter.reasoning(ev.text);
      if (failOnThinking && filter.thinking) return thinkingFound(ctl);
      continue;
    }
    if (ev.type === 'finish') {
      filter.end(ev.reason);
      finished = true;
      break;
    }
    filter.push(ev.text);
    if (failOnThinking && filter.thinking) return thinkingFound(ctl);
    const next = answer.update(filter.visible, false);
    if (!next.startsWith(fed)) continue;
    fed = next;
    if (acc.replace(next)) {
      ctl.abort();
      return true;
    }
  }
  if (!finished) filter.end();
  return acc.replace(answer.update(filter.visible, true));
}

function thinkingFound(ctl: AbortController): never {
  ctl.abort();
  throw new ThinkingError();
}
