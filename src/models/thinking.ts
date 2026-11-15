// Request fields that turn thinking off per (strategy x host flavor), and a streaming filter that
// removes reasoning from chat and FIM output. No upstream code is copied.
import type { HostFlavor, ThinkingStrategy } from '../types';

/** Every top-level request field `thinkingFields` can set; the retry in Task 3 drops one of these at a time. */
export const THINKING_FIELDS: readonly string[] = ['chat_template_kwargs', 'reasoning_effort', 'reasoning', 'thinking'];

export interface ThinkingFields { body: Record<string, unknown>; systemSuffix?: string }

const STRATA_BODY = { reasoning_effort: 'none', chat_template_kwargs: { enable_thinking: false } };

/** The `chat_template_kwargs` value that turns thinking off, or undefined for a strategy without a kwarg. */
function templateKwarg(strategy: ThinkingStrategy): Record<string, unknown> | undefined {
  switch (strategy) {
    case 'templateKwarg:enable_thinking': return { enable_thinking: false };
    case 'templateKwarg:thinking': return { thinking: false };
    case 'templateKwarg:thinking_mode=disabled': return { thinking_mode: 'disabled' };
    case 'templateKwarg:thinking_budget=0': return { thinking_budget: 0 };
    default: return undefined;
  }
}

function bodyFor(strategy: ThinkingStrategy, flavor: HostFlavor): Record<string, unknown> {
  switch (flavor) {
    case 'strata': return structuredClone(STRATA_BODY);
    case 'openrouter': return { reasoning: { effort: strategy === 'cannotDisable' ? 'low' : 'none' } };
    case 'deepseek': return strategy === 'cannotDisable' ? {} : { thinking: { type: 'disabled' } };
    case 'ollama': return { reasoning_effort: strategy === 'cannotDisable' ? 'low' : 'none' };
    default: break;
  }
  // lmstudio, llamacpp, vllm, sglang, fireworks, together, mistral, generic
  const kwarg = templateKwarg(strategy);
  if (kwarg) {
    const alsoEffort = flavor === 'lmstudio' || flavor === 'llamacpp' || flavor === 'vllm' || flavor === 'sglang';
    return alsoEffort ? { chat_template_kwargs: kwarg, reasoning_effort: 'none' } : { chat_template_kwargs: kwarg };
  }
  switch (strategy) {
    case 'reasoningEffortNone': return { reasoning_effort: 'none' };
    case 'systemSoftSwitch:/no_think': return flavor === 'lmstudio' ? { reasoning_effort: 'none' } : {};
    case 'vendorThinkingDisabled': return { thinking: { type: 'disabled' } };
    case 'cannotDisable': return { reasoning_effort: 'low' };
    default: return {}; // 'none'
  }
}

export function thinkingFields(strategy: ThinkingStrategy, flavor: HostFlavor): ThinkingFields {
  const out: ThinkingFields = { body: bodyFor(strategy, flavor) };
  if (strategy === 'systemSoftSwitch:/no_think') out.systemSuffix = '/no_think';
  return out;
}

interface Tag { text: string; kind: 'open' | 'close' | 'marker'; closer?: string }

const BLOCKS: readonly (readonly [string, string])[] = [
  ['<think>', '</think>'],
  ['<seed:think>', '</seed:think>'],
  ['<mm:think>', '</mm:think>'],
  ['<|channel>thought', '<channel|>'],
  ['[THINK]', '[/THINK]'],
  ['<|open|>think<|sep|>', '<|close|>think<|sep|>'],
  ['<|channel|>analysis<|message|>', '<|end|>'],
];
const MARKERS: readonly string[] = ['<|open|>response<|sep|>', '<|close|>response<|sep|>', '<|start|>assistant<|channel|>final<|message|>',
  '<|channel|>final<|message|>', '<|return|>'];

const TAGS: readonly Tag[] = [
  ...BLOCKS.map(([o, c]): Tag => ({ text: o, kind: 'open', closer: c })),
  ...BLOCKS.map(([, c]): Tag => ({ text: c, kind: 'close' })),
  ...MARKERS.map((m): Tag => ({ text: m, kind: 'marker' })),
];
const TAG_STARTS = new Set(TAGS.map((t) => t.text[0]));

const hasText = (s: string): boolean => /\S/.test(s);

interface Parsed { visible: string; thinking: boolean }

/** Parses the whole content so far. A trailing partial tag is held back unless `ended`. */
function parse(raw: string, ended: boolean, finishReason?: string): Parsed {
  let out = '';
  let thinking = false;
  let skipWs = false;
  let blockCloser: string | undefined; // set while inside a reasoning block
  let blockStart = 0;                  // index into raw where the block's content starts
  let outBeforeBlock = '';
  let i = 0;
  while (i < raw.length) {
    if (blockCloser !== undefined) {
      const at = raw.indexOf(blockCloser, i);
      if (at < 0) { i = raw.length; break; }
      if (hasText(raw.slice(blockStart, at))) thinking = true;
      i = at + blockCloser.length;
      blockCloser = undefined;
      skipWs = true;
      continue;
    }
    const ch = raw[i];
    if (!TAG_STARTS.has(ch)) {
      if (skipWs && /\s/.test(ch)) { i++; continue; }
      skipWs = false;
      out += ch;
      i++;
      continue;
    }
    const tag = TAGS.find((t) => raw.startsWith(t.text, i));
    if (tag) {
      i += tag.text.length;
      if (tag.kind === 'open') {
        blockCloser = tag.closer;
        blockStart = i;
        outBeforeBlock = out;
      } else if (tag.kind === 'close') {
        if (hasText(out)) thinking = true;
        out = '';
        skipWs = true;
      }
      continue;
    }
    const tail = raw.slice(i);
    if (!ended && TAGS.some((t) => t.text.startsWith(tail))) break; // partial tag: wait for more
    if (skipWs && /\s/.test(ch)) { i++; continue; }
    skipWs = false;
    out += ch;
    i++;
  }
  if (blockCloser !== undefined) {
    if (hasText(raw.slice(blockStart))) thinking = true;
    out = ended && finishReason === 'length' ? '' : outBeforeBlock;
  }
  return { visible: out, thinking };
}

/** Streaming: feed content and reasoning deltas, read `visible` at any time. `visible` can shrink (a bare closing tag). */
export class ReasoningFilter {
  private raw = '';
  private ended = false;
  private finish: string | undefined;
  private fieldThinking = false;
  private cache: Parsed | undefined;

  push(content: string): void {
    this.raw += content;
    this.cache = undefined;
  }

  /** A delta from a separate reasoning field. */
  reasoning(text: string): void {
    if (hasText(text)) this.fieldThinking = true;
  }

  end(finishReason?: string): void {
    this.ended = true;
    this.finish = finishReason;
    this.cache = undefined;
  }

  private parsed(): Parsed {
    return (this.cache ??= parse(this.raw, this.ended, this.finish));
  }

  get visible(): string { return this.parsed().visible; }

  /** Non-whitespace reasoning seen, in a field or between tags. */
  get thinking(): boolean { return this.fieldThinking || this.parsed().thinking; }
}

export function stripThinking(text: string, finishReason?: string): { text: string; thinking: boolean } {
  const f = new ReasoningFilter();
  f.push(text);
  f.end(finishReason);
  return { text: f.visible, thinking: f.thinking };
}
