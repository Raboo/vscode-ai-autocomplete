// Request fields that turn thinking off per (strategy x host flavor), and a streaming filter that
// removes reasoning from chat and FIM output. No upstream code is copied.
import type { HostFlavor, ThinkingStrategy } from '../types';

/** Every top-level request field `thinkingFields` can set. On a 400/422 the chat retry drops those the body names, or all of them when it names none. */
export const THINKING_FIELDS: readonly string[] = ['chat_template_kwargs', 'reasoning_effort', 'reasoning', 'thinking'];

/** What the Backends page and the logs call each strategy. */
export const THINKING_LABELS: Record<ThinkingStrategy, string> = {
  none: "Model doesn't think (send nothing)",
  'templateKwarg:enable_thinking': 'enable_thinking: false (Qwen3, GLM, Gemma 4, Nemotron 3)',
  'templateKwarg:thinking': 'thinking: false (DeepSeek V3.1/V3.2, Kimi K2.5, Granite 3.3)',
  'templateKwarg:thinking_mode=disabled': 'thinking_mode: disabled (MiniMax M3)',
  'templateKwarg:thinking_budget=0': 'thinking_budget: 0 (Seed-OSS)',
  reasoningEffortNone: 'reasoning_effort: none (Mistral Small 4, OpenAI-style APIs)',
  'systemSoftSwitch:/no_think': '/no_think in the system prompt (Nemotron Nano v2, early Qwen3)',
  vendorThinkingDisabled: 'thinking: {type: disabled} (DeepSeek, Z.ai, Moonshot APIs)',
  cannotDisable: "Can't be turned off (completions disabled)",
};

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

/** Whether `text` starts (after whitespace) with a reasoning opener. */
export const startsWithThinkOpener = (text: string): boolean => { const t = text.trimStart(); return BLOCKS.some(([o]) => t.startsWith(o)); };

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
  // `<|end|>` is also an end-of-turn token elsewhere (Phi), so it closes reasoning only after its opener, never bare.
  ...BLOCKS.filter(([, c]) => c !== '<|end|>').map(([, c]): Tag => ({ text: c, kind: 'close' })),
  ...MARKERS.map((m): Tag => ({ text: m, kind: 'marker' })),
];
const TAG_STARTS = new Set(TAGS.map((t) => t.text[0]));

const hasText = (s: string): boolean => /\S/.test(s);

interface Parsed { visible: string; thinking: boolean }

/**
 * Parses the whole content so far. A trailing partial tag is held back unless `ended`.
 * A bare closing tag (no opener seen) ends hidden reasoning only when `mayThink`; otherwise it is answer text.
 */
function parse(raw: string, ended: boolean, mayThink: boolean, finishReason?: string): Parsed {
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
      } else if (tag.kind === 'close' && !mayThink) {
        out += tag.text;
        skipWs = false;
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

export interface ReasoningFilterOptions {
  /**
   * The model may be thinking although it was asked not to: its strategy is `cannotDisable`, or the session learned it
   * keeps thinking. Only then does a bare closing tag (no opener seen) hide the text before it; otherwise that tag is
   * answer text, such as code that holds `</think>`. An opener and its closer are reasoning either way. Default false.
   */
  mayThink?: boolean;
}

/** Streaming: feed content and reasoning deltas, read `visible` at any time. With `mayThink`, `visible` can shrink (a bare closing tag). */
export class ReasoningFilter {
  private readonly mayThink: boolean;
  private raw = '';
  private ended = false;
  private finish: string | undefined;
  private fieldThinking = false;
  private cache: Parsed | undefined;

  constructor(opts: ReasoningFilterOptions = {}) {
    this.mayThink = opts.mayThink === true;
  }

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
    return (this.cache ??= parse(this.raw, this.ended, this.mayThink, this.finish));
  }

  get visible(): string { return this.parsed().visible; }

  /** Non-whitespace reasoning seen, in a field or between tags. */
  get thinking(): boolean { return this.fieldThinking || this.parsed().thinking; }
}

/**
 * Reasoning that leaked without its opener (a template that prefills `<think>`): a bare closing tag that ends its line,
 * with non-blank text before it and no opener before it. A closer inside a line, such as `'</think>';`, is code.
 */
export function leakedReasoning(text: string): boolean {
  return BARE_CLOSERS.some((c) => {
    for (let at = text.indexOf(c); at >= 0; at = text.indexOf(c, at + 1)) {
      const before = text.slice(0, at);
      if (BLOCKS.some(([o]) => before.includes(o))) return false;
      if (hasText(before) && /^[ \t]*(\r?\n|$)/.test(text.slice(at + c.length))) return true;
    }
    return false;
  });
}
const BARE_CLOSERS: readonly string[] = TAGS.filter((t) => t.kind === 'close').map((t) => t.text);

/**
 * FIM output: removes a reasoning block at the very start (after optional whitespace) and the whitespace after it;
 * an unclosed one leaves nothing. Tags anywhere else stay: there they are code, such as a string holding `</think>`.
 */
export function stripLeadingReasoning(text: string): string {
  const body = text.trimStart();
  const block = BLOCKS.find(([open]) => body.startsWith(open));
  if (!block) return text;
  const [open, close] = block;
  const end = body.indexOf(close, open.length);
  return end < 0 ? '' : body.slice(end + close.length).trimStart();
}

export function stripThinking(text: string, finishReason?: string, opts: ReasoningFilterOptions = {}): { text: string; thinking: boolean } {
  const f = new ReasoningFilter(opts);
  f.push(text);
  f.end(finishReason);
  return { text: f.visible, thinking: f.thinking };
}
