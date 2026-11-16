# LM Studio MLX Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Completions on LM Studio keep the leading space MLX drops, and an answer cut at its token limit after a line break is shown instead of failing.

**Architecture:** A pure `src/backends/firstSpace.ts` decides the held text and repairs a stream. `buildFimRequest` holds the text back on the `lmstudio` flavor's template route and records it on the request; `OpenAiCompatBackend.streamFim` repairs its own text stream with it, so the editor and Test share the repair. The same backend sends LM Studio only stops without whitespace.

**Tech Stack:** TypeScript, vitest, @vscode/test-electron with the mock server.

**Spec:** `docs/superpowers/specs/2026-11-16-lmstudio-mlx-fixes-design.md`

## Global Constraints

- The repair applies only to FIM requests on the `lmstudio` host flavor over the template route; llama.cpp, other flavors, the native and chat routes and Next Edit are unchanged.
- Held text: `/\S[ \t]*$/` on the cursor's line (the text after the prefix's last `\n`); nothing when that line is empty or whitespace only.
- With held text, an answer that does not start with it gives no suggestion; without, an answer starting with a space gets one more.
- LM Studio FIM requests send only stops without whitespace (`/\s/`); the client still applies every stop.
- Commits use `fix:` / `test:` / `docs:` subjects and carry no Co-Authored-By trailer.

## Review Focus

- Chunks split inside the held text (`:` then `\n  return`): the repair buffers until it can decide.
- An answer shorter than the held text (the model stopped early): no suggestion, no crash.
- A prefix whose cursor line is empty after blank lines: nothing held, the line-start rule only.
- Tabs: the trim removes spaces only; a tab-indented answer is never given a space.
- The stop filter must not drop Next Edit's raw-format stops (`<|file_sep|>`, `<[end▁of▁sentence]>`).

---

### Task 1: The repair and the LM Studio stops

**Files:**
- Create: `src/backends/firstSpace.ts`, `test/unit/firstSpace.test.ts`
- Modify: `src/backends/types.ts` (`FimRequest.firstSpace?: { held: string }`, `onUnrepaired?(): void`), `src/completion/route.ts` (`FimRequestPlan.flavor?: HostFlavor`), `src/backends/openaiCompat.ts`, `src/completion/provider.ts` and `src/manage/connectionTest.ts` (pass `flavor`; the provider logs a miss at debug), `test/unit/route.test.ts`, `test/unit/openaiCompat.test.ts`

**Interfaces:**
- Produces: `heldText(prefix: string): string`; `repairFirstSpace(chunks: AsyncIterable<string>, held: string, onMiss?: () => void): AsyncGenerator<string>`.

- [x] **Step 1: Tests.** `heldText`: `'    return'`→`'n'`, `'return '`→`'n '`, `'x =\t'`→`'=\t'`, `'def f(x):\n'`→`''`, `'def f(x):\n  '`→`''`, `'a\n\n\n'`→`''`, `''`→`''`. `repairFirstSpace`: held `'n'` with `['n a', ' + b']`→`' a + b'`; held `':'`... split `[':', '\n  return']` with held `':'` → `'\n  return'`; held `'n '` with `['n', ' a']`→`'a'`; mismatch `['x']` with held `'n'` → nothing and `onMiss` once; answer shorter than held (`['n']` with held `'n '`) → nothing, no `onMiss`; held `''`: `['   return']`→`'    return'`, `['return']` unchanged, `['\treturn']` unchanged, `['', ' x']`→`'  x'`. `buildFimRequest` with `flavor: 'lmstudio'` and the qwen template renders the prefix without the held text and sets `firstSpace`; other flavors and the native route leave both alone. `OpenAiCompatBackend`: lmstudio sends `['<|endoftext|>']` for stops `['\n\n\n', '<|endoftext|>', '\n+++++ ']`, vllm sends all; a lmstudio stream with `firstSpace: { held: 'n' }` and SSE `n a`, ` + b` yields ` a + b`.
- [x] **Step 2: Run** `npx vitest run test/unit/firstSpace.test.ts test/unit/route.test.ts test/unit/openaiCompat.test.ts`: FAIL.
- [x] **Step 3: Implement** as in Interfaces and Global Constraints.
- [x] **Step 4: Run all checks:** `npm run build && npm test && npm run typecheck && npm run lint`.
- [x] **Step 5: Commit:** `fix: keep the leading space LM Studio's MLX engine drops`

### Task 2: Integration test with an MLX-like mock

**Files:**
- Modify: `test/integration/mockServer.ts` (`mlx?: { content: string[] }`: `POST /v1/completions` streams the content with one leading space removed from the first non-empty text, ends with finish `stop`), `test/integration/fim.test.ts`

- [x] **Step 1: Tests:** an LM Studio backend (`hostFlavor: 'lmstudio'`, `${baseUrl}/v1`, qwen-coder alias) on `return` with mock content `['n a + b;']` completes to `return a + b;` and the request's prompt ends the prefix with `retur`; on the empty line after `{` with content `['  return a + b;']` (the mock trims it to one space) the completion is indented two spaces; the request carries no `\n\n\n` stop.
- [x] **Step 2: Run** `npm run test:integration`: the new tests pass, the known local failures are unchanged.
- [x] **Step 3: Commit:** `test: LM Studio MLX repair end to end`

### Task 3: Docs

**Files:** `README.md` (LM Studio MLX paragraph: fixed, how), `docs/superpowers/followups/2026-11-13-phase0-1-review-followups.md` (the MLX FIM entry: fixed), `docs/ROADMAP.md` (3c released in v0.5.0; new row for this fix), `AGENTS.md` (layout line for `backends/firstSpace.ts`).

- [x] **Step 1: Update the docs.**
- [x] **Step 2: Commit:** `docs: LM Studio MLX fixes`

### Live check (before the PR)

Bundle a probe with esbuild that calls `buildFimRequest` + `OpenAiCompatBackend` + `collectCompletion` against the user's LM Studio (`sweep-next-edit-v2-7b-oq4e`) for the design's cases, and check the shown text.
