import { describe, expect, test, vi } from 'vitest';
import { heldText, repairFirstSpace } from '../../src/backends/firstSpace';

async function* chunks(...xs: string[]): AsyncGenerator<string> {
  for (const x of xs) yield x;
}
const repaired = async (held: string, xs: string[], onMiss?: () => void, lineStart = true): Promise<string> => {
  let out = '';
  for await (const c of repairFirstSpace(chunks(...xs), { held, lineStart }, onMiss)) out += c;
  return out;
};

describe('heldText', () => {
  test("the cursor line's last non-space character and the spaces or tabs after it", () => {
    expect(heldText('def add(a, b):\n    return')).toBe('n');
    expect(heldText('    return ')).toBe('n ');
    expect(heldText('x =\t')).toBe('=\t');
    expect(heldText('names = [u.na')).toBe('a');
  });
  test('nothing on an empty or indentation-only line, also after blank lines', () => {
    expect(heldText('def f(x):\n')).toBe('');
    expect(heldText('def f(x):\n  ')).toBe('');
    expect(heldText('a\n\n\n')).toBe('');
    expect(heldText('')).toBe('');
    expect(heldText('   ')).toBe('');
  });
});

describe('repairFirstSpace with held text', () => {
  test('drops the held text the answer starts with, keeping the space after it', async () => {
    expect(await repaired('n', ['n a', ' + b'])).toBe(' a + b');
    expect(await repaired('a', ['ame'])).toBe('me');
    expect(await repaired('n ', ['n', ' a', ' + b'])).toBe('a + b');
  });
  test('buffers chunks that end inside the held text', async () => {
    expect(await repaired('= ', ['=', '', ' 0'])).toBe('0');
    expect(await repaired('n ', ['n', ' '])).toBe('');
  });
  test('an answer that does not continue the line gives nothing and reports the miss once', async () => {
    const onMiss = vi.fn();
    expect(await repaired('n', ['x', 'y'], onMiss)).toBe('');
    expect(onMiss).toHaveBeenCalledTimes(1);
    const early = vi.fn();
    expect(await repaired('n ', ['nx'], early)).toBe('');
    expect(early).toHaveBeenCalledTimes(1);
  });
  test('an answer that ends inside the held text gives nothing, without a miss', async () => {
    const onMiss = vi.fn();
    expect(await repaired('n ', ['n'], onMiss)).toBe('');
    expect(await repaired('n', [], onMiss)).toBe('');
    expect(onMiss).not.toHaveBeenCalled();
  });
});

describe('repairFirstSpace at the start of a line', () => {
  test('an answer that still starts with a space lost one, and gets it back', async () => {
    expect(await repaired('', ['   return', ' x'])).toBe('    return x');
    expect(await repaired('', ['', ' x'])).toBe('  x');
  });
  test('the line-start rule may be decided while the answer streams (a pending engine lookup)', async () => {
    let out = '';
    for await (const c of repairFirstSpace(chunks('   return'), { held: '', lineStart: Promise.resolve(true) })) out += c;
    expect(out).toBe('    return');
  });
  test('without the line-start rule (an engine not known to trim) nothing is added', async () => {
    expect(await repaired('', ['    return'], undefined, false)).toBe('    return');
    // The held text is still removed: the prompt was shortened either way.
    expect(await repaired('n', ['n a'], undefined, false)).toBe(' a');
  });
  test('any other start is left alone, tabs included; later chunks are untouched', async () => {
    expect(await repaired('', ['return', ' x'])).toBe('return x');
    expect(await repaired('', ['\treturn'])).toBe('\treturn');
    expect(await repaired('', ['\n   x', ' y'])).toBe('\n   x y');
  });
});
