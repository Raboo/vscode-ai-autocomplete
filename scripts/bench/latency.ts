// Latency benchmark for local models, run against a llama-server router the developer started (never part of the
// package). Uses the extension's own prompt and request code, so the numbers match what the editor sends.
//
//   npx esbuild scripts/bench/latency.ts --bundle --platform=node --format=cjs --outfile=out/bench.cjs
//   node out/bench.cjs http://127.0.0.1:8012 nextEdit:zeta-2.1 nextEdit:sweep-next-edit-1.5b completions:sweep-next-edit-1.5b
//
// Each case is a real file from this repository: Next Edit cases rename a variable at its declaration (the model should
// rename the later uses); completion cases cut a line in half. Each case runs cold (a new file), then warm (the same
// prompt after one more typed character, as when the user keeps typing). Prints median and p90 time to first and last token.
import { readFileSync } from 'node:fs';
import { LlamaCppBackend } from '../../src/backends/llamacpp';
import type { FimRequest } from '../../src/backends/types';
import { pickFormat } from '../../src/nextEdit/formats';
import type { CompletionFormat, NextEditInput } from '../../src/nextEdit/formats/format';
import { renderDiff } from '../../src/nextEdit/history';
import { nextEditBudgets } from '../../src/nextEdit/region';

const FILES = ['src/local/router.ts', 'src/local/extraArgs.ts', 'src/completion/outcomes.ts', 'src/nextEdit/trigger.ts', 'src/local/modelList.ts', 'src/backends/llamacpp.ts'];

interface Timing { first: number; last: number; chars: number }

/** A `const x = …` line whose name is used again within 10 lines, renamed at the declaration. */
function renameCase(path: string, typed: string): NextEditInput | undefined {
  const before = readFileSync(path, 'utf8').split('\n');
  for (let i = 0; i < before.length; i++) {
    const m = /^(\s*)const ([a-z][A-Za-z]{3,}) = /.exec(before[i]);
    if (!m) continue;
    const name = m[2];
    const later = before.slice(i + 1, i + 11).some((l) => new RegExp(`\\b${name}\\b`).test(l));
    if (!later) continue;
    const lines = [...before];
    lines[i] = before[i].replace(`const ${name} =`, `const ${name}Value${typed} =`);
    const format = pickFormat('auto', 'zeta-2.1');
    const cursor = { line: i, character: lines[i].indexOf(`${name}Value`) + name.length + 5 + typed.length };
    const text = renderDiff(path, before.join('\n'), lines.join('\n')) ?? '';
    return {
      path,
      lines,
      cursor,
      region: format.region(i, lines.length, { above: 5, below: 10 }),
      history: [{ path, text, hunks: [{ oldStart: i, newStart: i, oldLines: [before[i]], newLines: [lines[i]] }] }],
      snippets: [],
      budgets: nextEditBudgets(3500),
      previous: { lines: before, hunks: [{ oldStart: i, newStart: i, oldLines: [before[i]], newLines: [lines[i]] }] },
    };
  }
  return undefined;
}

/** The middle of a non-trivial line around the file's middle: prefix up to there, suffix from there. */
function completionCase(path: string, typed: string): { prefix: string; suffix: string } {
  const lines = readFileSync(path, 'utf8').split('\n');
  let i = Math.floor(lines.length / 2);
  while (i < lines.length - 1 && lines[i].trim().length < 30) i++;
  const cut = Math.floor(lines[i].length / 2);
  return { prefix: [...lines.slice(0, i), lines[i].slice(0, cut) + typed].join('\n'), suffix: [lines[i].slice(cut), ...lines.slice(i + 1)].join('\n') };
}

async function timed(chunks: AsyncIterable<string>): Promise<Timing> {
  const start = performance.now();
  let first = -1;
  let chars = 0;
  for await (const c of chunks) {
    if (first < 0 && c !== '') first = performance.now() - start;
    chars += c.length;
  }
  const last = performance.now() - start;
  return { first: first < 0 ? last : first, last, chars };
}

function request(model: string, partial: Omit<FimRequest, 'model' | 'extraBody' | 'signal' | 'timeoutMs'>): FimRequest {
  return { model, extraBody: {}, signal: new AbortController().signal, timeoutMs: 60_000, ...partial };
}

const quantile = (xs: number[], q: number): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
};

async function main(): Promise<void> {
  const [baseUrl, ...targets] = process.argv.slice(2);
  if (!baseUrl || targets.length === 0) throw new Error('usage: node bench.cjs <router url> <nextEdit|completions>:<model> ...');
  const backend = new LlamaCppBackend({ id: 'bench', kind: 'llamacpp', baseUrl } as never, async () => undefined);
  for (const target of targets) {
    const [feature, model] = target.split(':');
    const runs: Timing[] = [];
    const warmRuns: Timing[] = [];
    for (const [n, path] of FILES.entries()) {
      const send = (typed: string): AsyncIterable<string> | undefined => {
        if (feature === 'nextEdit') {
          const input = renameCase(path, typed);
          if (!input) return undefined;
          const format = pickFormat('auto', model) as CompletionFormat;
          const p = format.prompt({ ...input, region: format.region(input.cursor.line, input.lines.length, { above: 5, below: 10 }) });
          return backend.streamFim(request(model, { payload: { route: 'template', prompt: p.prompt }, slot: 'nextEdit', stop: p.stop, sampling: { temperature: 0, maxTokens: p.maxTokens } }));
        }
        const { prefix, suffix } = completionCase(path, typed);
        return backend.streamFim(request(model, { payload: { route: 'native', prefix, suffix, extra: [], filePath: path, repoName: 'autocomplete' }, slot: 'completions', stop: ['\n\n\n'], sampling: { temperature: 0.1, maxTokens: 128 }, timeMaxPredictMs: 500 }));
      };
      const cold = send('');
      if (!cold) continue;
      const c = await timed(cold);
      const warm = send('x');
      const w = warm ? await timed(warm) : c;
      // The first file of each model includes its load; it is reported but not counted.
      if (n === 0) console.log(`${target}: first request ${Math.round(c.last)} ms (load + cold cache)`);
      else {
        runs.push(c);
        warmRuns.push(w);
      }
    }
    for (const [label, rs] of [['cold', runs], ['warm', warmRuns]] as const) {
      const f = rs.map((r) => r.first);
      const l = rs.map((r) => r.last);
      console.log(`${target} ${label}: ${rs.length} runs · first token median ${Math.round(quantile(f, 0.5))} ms, p90 ${Math.round(quantile(f, 0.9))} ms · whole answer median ${Math.round(quantile(l, 0.5))} ms, p90 ${Math.round(quantile(l, 0.9))} ms · ${Math.round(rs.reduce((a, r) => a + r.chars, 0) / Math.max(1, rs.length))} chars`);
    }
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
