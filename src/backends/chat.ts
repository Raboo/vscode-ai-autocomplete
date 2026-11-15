import { THINKING_FIELDS } from '../models/thinking';
import { HttpError, postJson, throwIfStreamError } from './http';
import { parseSse } from './sse';
import type { ChatEvent, ChatRequest } from './types';

export const SAMPLING_FIELDS: readonly string[] = ['temperature', 'top_p', 'top_k', 'presence_penalty'];
export const RETRY_STATUSES: readonly number[] = [400, 422];

const HOSTED_MAX_STOPS = 4;

export function chatBody(req: ChatRequest, hosted: boolean): Record<string, unknown> {
  const { sampling } = req;
  return {
    ...(req.model ? { model: req.model } : {}),
    messages: req.messages,
    max_tokens: req.maxTokens,
    ...(sampling.temperature !== undefined ? { temperature: sampling.temperature } : {}),
    ...(sampling.topP !== undefined ? { top_p: sampling.topP } : {}),
    ...(!hosted && sampling.topK !== undefined ? { top_k: sampling.topK } : {}),
    ...(sampling.presencePenalty !== undefined ? { presence_penalty: sampling.presencePenalty } : {}),
    ...(req.stop.length > 0 ? { stop: hosted ? req.stop.slice(0, HOSTED_MAX_STOPS) : req.stop } : {}),
    stream: true,
    ...req.thinking,
    ...req.extraBody,
  };
}

/** The sent optional fields a 400/422 body names (whole word, case-insensitive): 'reasoning' never matches 'reasoning_effort'. */
export function rejectedFields(bodyText: string, sent: readonly string[]): string[] {
  return sent.filter((f) => new RegExp(`(?<![A-Za-z0-9_])${f}(?![A-Za-z0-9_])`, 'i').test(bodyText));
}

async function post(url: string, headers: Record<string, string>, body: Record<string, unknown>, req: ChatRequest): Promise<Response> {
  return postJson(url, body, { headers, signal: req.signal, timeoutMs: req.timeoutMs });
}

export async function* streamOpenAiChat(url: string, headers: Record<string, string>, req: ChatRequest, hosted: boolean): AsyncGenerator<ChatEvent> {
  const body = chatBody(req, hosted);
  let res: Response;
  try {
    res = await post(url, headers, body, req);
  } catch (err) {
    if (!(err instanceof HttpError) || !RETRY_STATUSES.includes(err.status)) {
      throw err;
    }
    const sent = [...THINKING_FIELDS, ...SAMPLING_FIELDS].filter((f) => f in body);
    let drop = rejectedFields(err.bodyText, sent);
    if (drop.length === 0) {
      drop = THINKING_FIELDS.filter((f) => f in body);
    }
    if (drop.length === 0) {
      throw err;
    }
    const retryBody = Object.fromEntries(Object.entries(body).filter(([k]) => !drop.includes(k)));
    res = await post(url, headers, retryBody, req);
    req.onRejected?.(drop);
  }
  if (!res.body) {
    return;
  }
  for await (const data of parseSse(res.body)) {
    if (data === '') {
      continue;
    }
    const ev = JSON.parse(data) as { choices?: { delta?: Record<string, unknown>; finish_reason?: unknown }[] };
    throwIfStreamError(ev);
    const choice = ev.choices?.[0];
    const delta = choice?.delta;
    if (delta) {
      yield* deltaEvents(delta);
    }
    if (typeof choice?.finish_reason === 'string') {
      yield { type: 'finish', reason: choice.finish_reason };
    }
  }
}

function* deltaEvents(delta: Record<string, unknown>): Generator<ChatEvent> {
  for (const f of ['reasoning_content', 'reasoning', 'thinking']) {
    const v = delta[f];
    if (typeof v === 'string' && v !== '') {
      yield { type: 'reasoning', text: v };
    }
  }
  // OpenRouter sends the same text as `reasoning` and `reasoning_details`: the plain string wins.
  const details = typeof delta.reasoning === 'string' || typeof delta.reasoning_content === 'string' ? undefined : delta.reasoning_details;
  if (Array.isArray(details) && details.length > 0) {
    const text = details
      .map((d) => {
        const o = (d ?? {}) as { text?: unknown; summary?: unknown };
        return typeof o.text === 'string' ? o.text : typeof o.summary === 'string' ? o.summary : '';
      })
      .join('');
    yield { type: 'reasoning', text: text || '…' };
  }
  const c = delta.content;
  if (typeof c === 'string') {
    if (c !== '') yield { type: 'content', text: c };
  } else if (Array.isArray(c)) {
    for (const item of c as { type?: unknown; text?: unknown; thinking?: unknown }[]) {
      if (item?.type === 'text' && typeof item.text === 'string' && item.text !== '') {
        yield { type: 'content', text: item.text };
      } else if (item?.type === 'thinking' && Array.isArray(item.thinking)) {
        const text = (item.thinking as { text?: unknown }[]).map((t) => (typeof t?.text === 'string' ? t.text : '')).join('');
        if (text !== '') yield { type: 'reasoning', text };
      }
    }
  }
}
