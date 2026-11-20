import * as fsPromises from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { basename, dirname, join } from 'node:path';

/** Writes `text` so a failure never leaves a partial file: temp file in the target's folder, then rename. Symlinks are kept (the real file is replaced) and the mode is preserved. */
export async function writeFileAtomic(path: string, text: string, fs: typeof fsPromises = fsPromises): Promise<void> {
  let target = path;
  let mode: number | undefined;
  try {
    target = await fs.realpath(path);
    mode = (await fs.stat(target)).mode & 0o777;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  const tmp = join(dirname(target), `.${basename(target)}.${randomBytes(6).toString('hex')}.tmp`);
  try {
    await fs.writeFile(tmp, text, { encoding: 'utf8', ...(mode === undefined ? {} : { mode }) });
    if (mode !== undefined) await fs.chmod(tmp, mode);
    await fs.rename(tmp, target);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
}
