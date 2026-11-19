// Moving downloaded model files to a new models folder: a rename on the same volume, else copy, check the size and
// delete. All or nothing: a failure puts back what this run moved and leaves the originals in place.
import * as fs from 'node:fs/promises';
import { dirname } from 'node:path';

export interface MoveFs {
  rename(from: string, to: string): Promise<void>;
  copyFile(from: string, to: string): Promise<void>;
  stat(path: string): Promise<{ size: number }>;
  rm(path: string, o: { force: boolean }): Promise<void>;
  mkdir(path: string, o: { recursive: true }): Promise<unknown>;
}

export interface FileMove { from: string; to: string; bytes: number }

/** Fixed text: the error is shown on the page and the details go to the log. */
export const MOVE_FAILED = 'Moving the model files failed; they stay in the old folder.';

export class MoveError extends Error {
  constructor(readonly cause: unknown) {
    super(MOVE_FAILED);
    this.name = 'MoveError';
  }
}

const REAL: MoveFs = {
  rename: (a, b) => fs.rename(a, b),
  copyFile: (a, b) => fs.copyFile(a, b),
  stat: (p) => fs.stat(p),
  rm: (p, o) => fs.rm(p, o),
  mkdir: (p, o) => fs.mkdir(p, o),
};

export async function moveModelFiles(files: FileMove[], over: Partial<MoveFs> = {}): Promise<void> {
  const f: MoveFs = { ...REAL, ...over };
  const done: (FileMove & { copied: boolean })[] = [];
  try {
    for (const m of files) {
      await f.mkdir(dirname(m.to), { recursive: true });
      try {
        await f.rename(m.from, m.to);
        done.push({ ...m, copied: false });
        continue;
      } catch (err) {
        if ((err as NodeJS.ErrnoException | undefined)?.code !== 'EXDEV') throw err;
      }
      // Another volume: the copy counts only when it has the whole file; the original goes once every copy is made.
      done.push({ ...m, copied: true });
      await f.copyFile(m.from, m.to);
      if ((await f.stat(m.to)).size !== m.bytes) throw new Error(`copy of ${m.from} has the wrong size`);
    }
  } catch (err) {
    for (const m of done.reverse()) {
      if (m.copied) await f.rm(m.to, { force: true }).catch(() => undefined);
      else await f.rename(m.to, m.from).catch(() => undefined);
    }
    throw new MoveError(err);
  }
  for (const m of done) if (m.copied) await f.rm(m.from, { force: true }).catch(() => undefined);
}
