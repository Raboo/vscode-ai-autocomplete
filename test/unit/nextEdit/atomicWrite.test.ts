import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fsp from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFileAtomic } from '../../../src/nextEdit/atomicWrite';

let dir: string;
beforeEach(async () => {
  dir = await fsp.mkdtemp(join(tmpdir(), 'atomic-'));
});
afterEach(async () => {
  await fsp.rm(dir, { recursive: true, force: true });
});

describe('writeFileAtomic', () => {
  it('writes a missing file fresh and leaves no temp file', async () => {
    const p = join(dir, 'argv.json');
    await writeFileAtomic(p, 'new');
    expect(await fsp.readFile(p, 'utf8')).toBe('new');
    expect(await fsp.readdir(dir)).toEqual(['argv.json']);
  });

  it('keeps the symlink and updates the real file', async () => {
    const real = join(dir, 'real.json');
    const link = join(dir, 'link.json');
    await fsp.writeFile(real, 'old');
    await fsp.symlink(real, link);
    await writeFileAtomic(link, 'new');
    expect((await fsp.lstat(link)).isSymbolicLink()).toBe(true);
    expect(await fsp.readFile(real, 'utf8')).toBe('new');
  });

  it('keeps the mode', async () => {
    const p = join(dir, 'argv.json');
    await fsp.writeFile(p, 'old');
    await fsp.chmod(p, 0o640);
    await writeFileAtomic(p, 'new');
    expect((await fsp.stat(p)).mode & 0o777).toBe(0o640);
  });

  it('leaves the original untouched and removes the temp file when the write fails', async () => {
    const p = join(dir, 'argv.json');
    await fsp.writeFile(p, 'old');
    const failing = {
      ...fsp,
      writeFile: async (path: string, data: string) => {
        await fsp.writeFile(path, data.slice(0, 1));
        throw new Error('disk full');
      },
    } as unknown as typeof fsp;
    await expect(writeFileAtomic(p, 'new', failing)).rejects.toThrow('disk full');
    expect(await fsp.readFile(p, 'utf8')).toBe('old');
    expect(await fsp.readdir(dir)).toEqual(['argv.json']);
  });
});
