import type { ChatMessage } from '../backends/types';
import type { TemplateInput } from '../models/templates';

export const CURSOR_MARKER = '<|cursor|>';
export const COMPLETION_OPEN = '<COMPLETION>';
export const COMPLETION_CLOSE = '</COMPLETION>';

export const HOLE_FILLER_SYSTEM = `You complete code inside an editor. The user sends one file, and the marker ${CURSOR_MARKER} shows where the cursor is. Other files from the project may come first, for reference.

Answer with the text to insert at the cursor and nothing else, wrapped as ${COMPLETION_OPEN}text${COMPLETION_CLOSE}.
- Write only new text. Never repeat what is already before or after the cursor.
- Follow the file's language, indentation and naming.
- End where the code after the cursor takes over.
- No explanations and no Markdown code fences.
- If nothing should be inserted, answer ${COMPLETION_OPEN}${COMPLETION_CLOSE}.`;

export interface HoleFillerInput extends TemplateInput { languageId: string; multiline: boolean }

/** Extra files first and the current file last, so the part that changes while typing sits at the end and prefix caches reuse the start. */
export function holeFillerMessages(i: HoleFillerInput, systemSuffix?: string): ChatMessage[] {
  const extra = i.extra.map(f => `<file path="${f.path}">\n${f.text}\n</file>\n`).join('');
  const ask = i.multiline
    ? `Insert the code that belongs at ${CURSOR_MARKER}.`
    : `Insert the code that belongs at ${CURSOR_MARKER}, on the cursor line only.`;
  const user = `${extra}<file path="${i.filePath}" language="${i.languageId}">\n${i.prefix}${CURSOR_MARKER}${i.suffix}\n</file>\n${ask}`;
  const system = systemSuffix === undefined ? HOLE_FILLER_SYSTEM : `${HOLE_FILLER_SYSTEM}\n${systemSuffix}`;
  return [{ role: 'system', content: system }, { role: 'user', content: user }];
}

export const PIN_BACK_LINES = 4;

/**
 * Characters of the user message that stay the same while the user types near the cursor: everything before the start
 * of the line PIN_BACK_LINES above the cursor line (0 when there is none). Counted in code points, as Strata counts them.
 */
export function stableUserChars(messages: ChatMessage[]): number {
  const user = messages[1]?.content ?? '';
  // The marker also appears in the closing instruction, so look only before the end of the file block.
  const cursor = user.lastIndexOf(CURSOR_MARKER, user.lastIndexOf('\n</file>\n'));
  if (cursor < 0) return 0;
  let start = user.lastIndexOf('\n', cursor - 1) + 1;
  for (let i = 0; i < PIN_BACK_LINES && start > 0; i++) start = user.lastIndexOf('\n', start - 2) + 1;
  if (start <= 0) return 0;
  const head = user.slice(0, start);
  return /[\ud800-\udbff]/.test(head) ? [...head].length : start;
}

/** Extracts the inserted text from the visible (reasoning-free) chat output. */
export class HoleFillerAnswer {
  private readonly linePrefix: string;
  /** The line prefix when it is only indentation, else ''. */
  private readonly indent: string;

  constructor(linePrefix: string) {
    this.linePrefix = linePrefix.trimStart();
    this.indent = this.linePrefix === '' ? linePrefix : '';
  }

  /** The answer in `visible` (ReasoningFilter output) so far; `done` once the stream has ended. */
  update(visible: string, done: boolean): string {
    let answer: string;
    let complete = done;
    const open = visible.indexOf(COMPLETION_OPEN);
    if (open >= 0) {
      answer = visible.slice(open + COMPLETION_OPEN.length);
      const close = answer.indexOf(COMPLETION_CLOSE);
      if (close >= 0) {
        answer = answer.slice(0, close);
        complete = true;
      } else if (!done) {
        answer = answer.slice(0, answer.length - partialCloseLength(answer));
      }
    } else if (done) {
      answer = visible.endsWith(COMPLETION_CLOSE) ? visible.slice(0, -COMPLETION_CLOSE.length) : visible;
    } else {
      return '';
    }
    // The fence goes first: re-typed indentation or line prefix sits after the opening fence line.
    const fenced = unfence(answer, complete);
    return this.dropLinePrefix(fenced.text, complete || fenced.closed);
  }

  private dropLinePrefix(answer: string, complete: boolean): string {
    const p = this.linePrefix;
    if (p === '') return this.dropIndent(answer);
    const t = answer.trimStart();
    if (t.startsWith(p)) return t.slice(p.length);
    if (!complete && p.startsWith(t)) return '';
    return answer;
  }

  /**
   * After a line prefix of only indentation, models often type the indentation again. It is dropped from the first line
   * when every later non-blank line is indented at least as much, so the answer's lines keep their relative indentation.
   */
  private dropIndent(answer: string): string {
    const ind = this.indent;
    if (ind === '' || !answer.startsWith(ind)) return answer;
    const later = answer.split('\n').slice(1);
    return later.every((l) => l.trim() === '' || l.startsWith(ind)) ? answer.slice(ind.length) : answer;
  }
}

/**
 * Unwraps an answer that starts with a Markdown code fence, despite the prompt. The closing fence ends the answer
 * (`closed`); while streaming, an unfinished fence line is held back.
 */
function unfence(answer: string, complete: boolean): { text: string; closed: boolean } {
  const open = /^\s*```[^\n]*/.exec(answer);
  if (!open) return { text: !complete && /^\s*`{1,2}$/.test(answer) ? '' : answer, closed: false };
  const rest = answer.slice(open[0].length);
  if (!rest.startsWith('\n')) return { text: '', closed: false };
  const body = rest.slice(1);
  const close = /(^|\n)[ \t]*```/.exec(body);
  if (close) return { text: body.slice(0, close.index), closed: true };
  return { text: complete ? body : body.replace(/(^|\n)[ \t]*`{1,2}$/, ''), closed: false };
}

/** Length of the longest suffix of `text` that is a proper prefix of the closing tag. */
function partialCloseLength(text: string): number {
  for (let n = Math.min(COMPLETION_CLOSE.length - 1, text.length); n > 0; n--) {
    if (COMPLETION_CLOSE.startsWith(text.slice(text.length - n))) return n;
  }
  return 0;
}
