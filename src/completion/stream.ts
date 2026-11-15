import type { ChatEvent, ChatRequest, FimBackend, FimRequest } from '../backends/types';
import { ReasoningFilter } from '../models/thinking';
import type { CompletionAccumulator } from './filters';
import { HoleFillerAnswer } from './holeFiller';

export type PlannedRequest =
  | { route: 'native' | 'template'; req: FimRequest }
  | { route: 'chat'; req: ChatRequest; linePrefix: string };

export interface Collected { text: string; stoppedEarly: boolean; thinking: boolean; timedOut: boolean; /** Chat route: the visible model output before answer extraction. */ visible?: string }

/**
 * A chat request that timed out before its first complete line. The name stays `TimeoutError`, so it is classified
 * and described as a timeout, and `thinking` keeps whether the model reasoned before it ran out of time.
 */
export class ChatTimeoutError extends Error {
  constructor(
    message: string,
    readonly thinking: boolean,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'TimeoutError';
  }
}

const isTimeout = (err: unknown): boolean => (err as { name?: unknown } | null)?.name === 'TimeoutError';

/** The chat route's parsing state, kept outside the stream loop so a timeout can settle from it. */
interface ChatState { filter: ReasoningFilter; answer: HoleFillerAnswer }

/**
 * Streams one request into `acc` and returns `acc.text`. FIM routes push chunks as today (postprocess strips a leading reasoning block later).
 * The chat route feeds ReasoningFilter → HoleFillerAnswer → acc.replace(answer). When `acc` stops early, `ctl.abort()` ends the stream.
 * Throws the backend's error, except a TimeoutError after at least one complete line: those lines come back with timedOut true.
 * A chat timeout before the first complete line throws a ChatTimeoutError that keeps the thinking flag.
 */
export async function collectCompletion(
  backend: FimBackend,
  p: PlannedRequest,
  acc: CompletionAccumulator,
  ctl: AbortController,
): Promise<Collected> {
  let stopped = false;
  let chat: ChatState | undefined;
  try {
    if (p.route === 'chat') {
      chat = { filter: new ReasoningFilter(), answer: new HoleFillerAnswer(p.linePrefix) };
      stopped = await collectChat(backend.streamChat(p.req), chat, acc, ctl);
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
    if (nl < 0) {
      if (chat) throw new ChatTimeoutError((err as Error).message, chat.filter.thinking, { cause: err });
      throw err;
    }
    return { text: text.slice(0, nl), stoppedEarly: stopped, ...seen(chat), timedOut: true };
  }
  return { text: acc.text, stoppedEarly: stopped, ...seen(chat), timedOut: false };
}

function seen(chat: ChatState | undefined): { thinking: boolean; visible?: string } {
  return chat ? { thinking: chat.filter.thinking, visible: chat.filter.visible } : { thinking: false };
}

async function collectChat(events: AsyncIterable<ChatEvent>, { filter, answer }: ChatState, acc: CompletionAccumulator, ctl: AbortController): Promise<boolean> {
  // Only answers that extend the previous one reach `acc`: a shorter one (visible shrank on a bare closing tag) waits for the end.
  let fed = '';
  let finished = false;
  for await (const ev of events) {
    if (ev.type === 'reasoning') {
      filter.reasoning(ev.text);
      continue;
    }
    if (ev.type === 'finish') {
      filter.end(ev.reason);
      finished = true;
      break;
    }
    filter.push(ev.text);
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
