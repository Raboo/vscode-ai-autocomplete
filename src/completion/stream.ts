import type { ChatEvent, ChatRequest, FimBackend, FimRequest } from '../backends/types';
import { ReasoningFilter } from '../models/thinking';
import type { CompletionAccumulator } from './filters';
import { HoleFillerAnswer } from './holeFiller';

export type PlannedRequest =
  | { route: 'native' | 'template'; req: FimRequest }
  | { route: 'chat'; req: ChatRequest; linePrefix: string };

export interface Collected { text: string; stoppedEarly: boolean; thinking: boolean; timedOut: boolean }

const isTimeout = (err: unknown): boolean => (err as { name?: unknown } | null)?.name === 'TimeoutError';

/**
 * Streams one request into `acc` and returns `acc.text`. FIM routes push chunks as today (postprocess strips reasoning later).
 * The chat route feeds ReasoningFilter → HoleFillerAnswer → acc.replace(answer). When `acc` stops early, `ctl.abort()` ends the stream.
 * Throws the backend's error, except a TimeoutError after at least one complete line: those lines come back with timedOut true.
 */
export async function collectCompletion(
  backend: FimBackend,
  p: PlannedRequest,
  acc: CompletionAccumulator,
  ctl: AbortController,
): Promise<Collected> {
  let stopped = false;
  const seen = { thinking: false }; // updated as the chat stream goes, so a timeout keeps it
  try {
    if (p.route === 'chat') {
      stopped = await collectChat(backend.streamChat(p.req), new HoleFillerAnswer(p.linePrefix), acc, ctl, seen);
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
    const text = acc.text;
    const nl = text.lastIndexOf('\n');
    if (!isTimeout(err) || nl < 0) throw err;
    return { text: text.slice(0, nl), stoppedEarly: stopped, thinking: seen.thinking, timedOut: true };
  }
  return { text: acc.text, stoppedEarly: stopped, thinking: seen.thinking, timedOut: false };
}

async function collectChat(
  events: AsyncIterable<ChatEvent>,
  answer: HoleFillerAnswer,
  acc: CompletionAccumulator,
  ctl: AbortController,
  seen: { thinking: boolean },
): Promise<boolean> {
  const filter = new ReasoningFilter();
  // Only answers that extend the previous one reach `acc`: a shorter one (visible shrank on a bare closing tag) waits for the end.
  let fed = '';
  let stopped = false;
  let finished = false;
  for await (const ev of events) {
    if (ev.type === 'reasoning') {
      filter.reasoning(ev.text);
      seen.thinking = filter.thinking;
      continue;
    }
    if (ev.type === 'finish') {
      filter.end(ev.reason);
      finished = true;
      break;
    }
    filter.push(ev.text);
    seen.thinking = filter.thinking;
    const next = answer.update(filter.visible, false);
    if (!next.startsWith(fed)) continue;
    fed = next;
    if (acc.replace(next)) {
      stopped = true;
      ctl.abort();
      break;
    }
  }
  if (!stopped) {
    if (!finished) filter.end();
    stopped = acc.replace(answer.update(filter.visible, true));
  }
  seen.thinking = filter.thinking;
  return stopped;
}
