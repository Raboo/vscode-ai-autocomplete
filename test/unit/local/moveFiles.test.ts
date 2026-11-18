import { mkdtemp, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { MOVE_FAILED, moveModelFiles } from '../../../src/local/moveFiles';

let root: string;
const put = async (p: string, text: string): Promise<void> => {
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, text);
};
const exdev = async (): Promise<void> => {
  throw Object.assign(new Error('cross-device'), { code: 'EXDEV' });
};

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'move-files-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('moveModelFiles', () => {
  test('same volume: renames each file into the new folder, creating subfolders', async () => {
    const a = join(root, 'old', 'o', 'r', 'a.gguf');
    const b = join(root, 'old', 'o', 's', 'b.gguf');
    await put(a, 'aaa');
    await put(b, 'bb');
    const to = (p: string): string => p.replace(join(root, 'old'), join(root, 'new'));
    await moveModelFiles([{ from: a, to: to(a), bytes: 3 }, { from: b, to: to(b), bytes: 2 }]);
    expect(await readFile(to(a), 'utf8')).toBe('aaa');
    expect(await readFile(to(b), 'utf8')).toBe('bb');
    expect(existsSync(a) || existsSync(b)).toBe(false);
  });

  test('another volume: copies, checks the size, then deletes the originals', async () => {
    const a = join(root, 'old', 'a.gguf');
    await put(a, 'aaa');
    const dest = join(root, 'new', 'x', 'a.gguf');
    await moveModelFiles([{ from: a, to: dest, bytes: 3 }], { rename: exdev });
    expect(await readFile(dest, 'utf8')).toBe('aaa');
    expect(existsSync(a)).toBe(false);
  });

  test('a copy with the wrong size fails with fixed text; files moved before are put back and the originals stay', async () => {
    const a = join(root, 'old', 'a.gguf');
    const b = join(root, 'old', 'b.gguf');
    await put(a, 'aaa');
    await put(b, 'bbbb');
    let calls = 0;
    const err = await moveModelFiles(
      [{ from: a, to: join(root, 'new', 'a.gguf'), bytes: 3 }, { from: b, to: join(root, 'new', 'b.gguf'), bytes: 4 }],
      {
        // The second file is on another volume; the first one's rename back works.
        rename: async (x, y) => (++calls === 2 ? exdev() : rename(x, y)),
        copyFile: async (_x, y) => writeFile(y, 'bb'),
      },
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe(MOVE_FAILED);
    expect(await readFile(a, 'utf8')).toBe('aaa');
    expect(await readFile(b, 'utf8')).toBe('bbbb');
    expect(existsSync(join(root, 'new', 'a.gguf'))).toBe(false);
    expect(existsSync(join(root, 'new', 'b.gguf'))).toBe(false);
  });

  test('nothing to move is fine', async () => {
    await moveModelFiles([]);
    expect((await stat(root)).isDirectory()).toBe(true);
  });
});
