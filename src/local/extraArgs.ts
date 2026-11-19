// Extra llama-server arguments a user types for a local model: one line, split like a shell command line
// (quotes group words, no expansion). Flags the extension owns are refused.

const REFUSED_EXACT = new Set([
  'host', 'port', 'm', 'model', 'alias', 'a', 'c', 'ctx-size', 'np', 'parallel', 'api-key', 'api-key-file',
  'webui', 'no-webui', 'path', 'model-url', 'mu', 'model-draft', 'md', 'dr', 'docker-repo',
]);
const REFUSED_PREFIXES = ['hf', 'models-', 'ssl-', 'mmproj'];

function split(line: string): string[] | undefined {
  const out: string[] = [];
  let cur = '';
  let has = false;
  let quote: '"' | "'" | undefined;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      if (ch === quote) quote = undefined;
      else if (ch === '\\' && quote === '"' && (line[i + 1] === '"' || line[i + 1] === '\\')) cur += line[++i];
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
    } else if (ch === ' ' || ch === '\t') {
      if (has || cur !== '') out.push(cur);
      cur = '';
      has = false;
    } else {
      cur += ch;
    }
  }
  if (quote) return undefined;
  if (has || cur !== '') out.push(cur);
  return out;
}

function isFlag(token: string): boolean {
  return token.startsWith('-') && token.length > 1 && !/^-\d/.test(token) && !/^-\.\d/.test(token);
}

export function parseExtraArgs(line: string): { args: string[]; refused?: string } {
  if (/[\r\n\u0085\u2028\u2029]/.test(line)) return { args: [], refused: 'a line break' };
  const tokens = split(line);
  if (!tokens) return { args: [], refused: 'an unclosed quote' };
  const args: string[] = [];
  let prevFlag = false;
  for (const raw of tokens) {
    if (isFlag(raw)) {
      const eq = raw.indexOf('=');
      const flag = eq > 0 ? raw.slice(0, eq) : raw;
      const key = flag.replace(/^-+/, '');
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(key)) return { args: [], refused: flag };
      if (REFUSED_EXACT.has(key) || REFUSED_PREFIXES.some((p) => key.startsWith(p))) return { args: [], refused: flag };
      args.push(flag);
      prevFlag = true;
      if (eq > 0) {
        const value = raw.slice(eq + 1);
        if (/^[[;]/.test(value)) return { args: [], refused: flag };
        args.push(value);
        prevFlag = false;
      }
    } else {
      if (!prevFlag) return { args: [], refused: raw };
      if (/^[[;]/.test(raw)) return { args: [], refused: raw };
      args.push(raw);
      prevFlag = false;
    }
  }
  return { args };
}

/** `['--threads','8','--no-mmap']` becomes preset keys: `[['threads','8'],['no-mmap','true']]`. */
export function extraArgsToPreset(args: string[]): [key: string, value: string][] {
  const out: [string, string][] = [];
  for (let i = 0; i < args.length; i++) {
    const key = args[i].replace(/^-+/, '');
    const next = args[i + 1];
    if (next !== undefined && !isFlag(next)) {
      out.push([key, next]);
      i++;
    } else out.push([key, 'true']);
  }
  return out;
}
