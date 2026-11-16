/**
 * LM Studio's MLX engine drops one leading space from the first text a model sends (mlx-lm's streaming detokenizer), and
 * its text-only answers cannot tell a dropped space from a real continuation (`return` + `a` vs `u.na` + `me`). The repair:
 * - text on the cursor's line: the prompt leaves out the line's last non-space character and the spaces after it (the held
 *   text). The answer then starts with the held text, never with a space, and the repair removes it;
 * - an empty or indentation-only line: nothing is held. The trim removes a space only when the answer starts with one, so
 *   an answer that still starts with a space lost one, and one is added back; only for a model LM Studio reports as MLX,
 *   since another engine may not trim at all.
 * Design: docs/superpowers/specs/2026-11-16-lmstudio-mlx-fixes-design.md.
 */

/** The held text for `prefix`: the cursor line's last non-space character and the spaces or tabs after it; '' for an empty or blank line. */
export function heldText(prefix: string): string {
  const line = prefix.slice(prefix.lastIndexOf('\n') + 1);
  return /\S[ \t]*$/.exec(line)?.[0] ?? '';
}

/**
 * The answer `chunks` repaired for `held` (see heldText); `lineStart` applies the line-start rule when nothing is held.
 * Buffers until it can decide, as a chunk can end inside the held text.
 * An answer that does not start with `held` yields nothing and calls `onMiss`; one that ends inside it yields nothing.
 */
export async function* repairFirstSpace(chunks: AsyncIterable<string>, rules: { held: string; lineStart: boolean }, onMiss?: () => void): AsyncGenerator<string> {
  const { held, lineStart } = rules;
  let head = '';
  let decided = false;
  for await (const chunk of chunks) {
    if (decided) {
      yield chunk;
      continue;
    }
    head += chunk;
    if (head === '') continue;
    if (held === '') {
      decided = true;
      yield lineStart && head.startsWith(' ') ? ` ${head}` : head;
      continue;
    }
    if (head.length < held.length) {
      if (held.startsWith(head)) continue;
      onMiss?.();
      return;
    }
    if (!head.startsWith(held)) {
      onMiss?.();
      return;
    }
    decided = true;
    if (head.length > held.length) yield head.slice(held.length);
  }
}
