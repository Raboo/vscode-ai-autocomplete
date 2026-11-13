// Pure stream filters for FIM completions. Written from the ideas in Continue's
// line-stream filters and Kilo's useless-suggestion filter; no upstream code is copied.

export interface StreamFilterOptions {
  stop: string[];
  multiline: boolean;
  maxLines: number;
  suffix: string;
}

/** Levenshtein distance divided by the longer length (0 for two empty strings). */
export function levenshteinRatio(a: string, b: string): number {
  const max = Math.max(a.length, b.length);
  if (max === 0) return 0;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    prev = cur;
  }
  return prev[b.length] / max;
}

const FUZZY_MIN_LENGTH = 4;
const FUZZY_MAX_RATIO = 0.1;
const MAX_IDENTICAL_LINES = 3;

/** First non-blank line after the suffix's first line break, trimmed ('' if none). */
function nextExistingLine(suffix: string): string {
  const s = suffix.replace(/\r\n/g, '\n');
  const nl = s.indexOf('\n');
  if (nl < 0) return '';
  return (
    s
      .slice(nl + 1)
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l !== '') ?? ''
  );
}

export class CompletionAccumulator {
  private raw = '';
  private filtered = '';
  private stopped = false;
  private readonly nextLine: string;

  constructor(private readonly o: StreamFilterOptions) {
    this.nextLine = nextExistingLine(o.suffix);
  }

  /** Returns true once a rule has stopped the stream. */
  push(chunk: string): boolean {
    if (this.stopped) return true;
    this.raw += chunk;
    let text = this.raw.replace(/\r\n/g, '\n');
    if (text.endsWith('\r')) text = text.slice(0, -1); // hold a lone trailing CR for the next chunk
    const { text: out, stop } = this.apply(text);
    this.filtered = out;
    this.stopped = stop;
    return stop;
  }

  get text(): string {
    return this.filtered;
  }

  private apply(input: string): { text: string; stop: boolean } {
    let text = input;
    let stop = false;

    // 1. earliest stop string
    let cut = -1;
    for (const s of this.o.stop) {
      if (!s) continue;
      const i = text.indexOf(s);
      if (i >= 0 && (cut < 0 || i < cut)) cut = i;
    }
    if (cut >= 0) {
      text = text.slice(0, cut);
      stop = true;
    }

    // 2. single-line mode: cut at the first newline after content
    if (!this.o.multiline) {
      const m = /\S[^\n]*\n/.exec(text);
      if (m) {
        text = text.slice(0, m.index + m[0].length - 1);
        stop = true;
      }
    }

    // 3. maxLines
    const lines = text.split('\n');
    if (lines.length > this.o.maxLines) {
      text = lines.slice(0, this.o.maxLines).join('\n');
      stop = true;
    }

    // 4 and 5 look only at complete lines (followed by a newline)
    const complete = text.split('\n').slice(0, -1);

    // 4. three identical consecutive non-blank lines: keep one
    let run = 1;
    for (let i = 1; i < complete.length; i++) {
      const same = complete[i].trim() !== '' && complete[i] === complete[i - 1];
      run = same ? run + 1 : 1;
      if (run >= MAX_IDENTICAL_LINES) {
        return { text: complete.slice(0, i - run + 2).join('\n'), stop: true };
      }
    }

    // 5. a line that repeats the next existing line
    if (this.nextLine !== '') {
      for (let i = 0; i < complete.length; i++) {
        const t = complete[i].trim();
        if (t === '') continue;
        if (
          t === this.nextLine ||
          (t.length >= FUZZY_MIN_LENGTH && levenshteinRatio(t, this.nextLine) < FUZZY_MAX_RATIO)
        ) {
          return { text: complete.slice(0, i).join('\n'), stop: true };
        }
      }
    }

    return { text, stop };
  }
}

const HASH_COMMENT_LANGUAGES = new Set(['python', 'shellscript', 'yaml', 'ruby']);

export function shouldCompleteMultiline(
  mode: 'auto' | 'always' | 'never',
  linePrefix: string,
  lineSuffix: string,
  languageId: string,
): boolean {
  if (mode === 'always') return true;
  if (mode === 'never') return false;
  if (lineSuffix.trim() !== '') return false;
  const inComment = HASH_COMMENT_LANGUAGES.has(languageId)
    ? linePrefix.trimStart().startsWith('#')
    : /(^|[^:])\/\//.test(linePrefix); // "://" is a URL, not a comment
  return !inComment;
}
