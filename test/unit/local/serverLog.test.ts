import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { ServerLogFile, readLogTail, sectionLine, trimmed } from '../../../src/local/serverLog';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'serverlog-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('server log file', () => {
  test('sectionLine names the time and port', () => {
    expect(sectionLine(new Date('2026-11-19T10:00:00Z'), 8012)).toBe('===== llama-server started on port 8012 at 2026-11-19T10:00:00.000Z =====');
  });

  test('trimmed keeps the last part from a line start once the text passes the limit', () => {
    expect(trimmed('a\nb\nc\n', 100, 10)).toBeUndefined();
    expect(trimmed('line1\nline2\nline3\nline4\n', 20, 13)).toBe('line3\nline4\n');
  });

  test('appends a section and lines; a reader gets the last lines', async () => {
    const path = join(dir, 'llama-server.log');
    const log = new ServerLogFile(path, { now: () => new Date('2026-11-19T10:00:00Z') });
    log.start(8012);
    for (let i = 0; i < 5; i++) log.line(`l${i}`);
    await log.flush();
    const text = await readFile(path, 'utf8');
    expect(text).toBe('===== llama-server started on port 8012 at 2026-11-19T10:00:00.000Z =====\nl0\nl1\nl2\nl3\nl4\n');
    expect(await readLogTail(path, 2)).toEqual(['l3', 'l4']);
  });

  test('a file past the limit is cut to its last part when a section starts, not on every append', async () => {
    const path = join(dir, 'llama-server.log');
    const big = `${'x'.repeat(50)}\n`.repeat(10);
    await writeFile(path, big, 'utf8');
    const log = new ServerLogFile(path, { maxBytes: 300, keepBytes: 120, now: () => new Date('2026-11-19T10:00:00Z') });
    log.line('more');
    await log.flush();
    expect(await readFile(path, 'utf8')).toBe(`${big}more\n`);
    log.start(8012);
    log.line('new');
    await log.flush();
    const text = await readFile(path, 'utf8');
    expect(text.startsWith('x')).toBe(true);
    expect(text.endsWith(`${sectionLine(new Date('2026-11-19T10:00:00Z'), 8012)}\nnew\n`)).toBe(true);
    expect(text.length).toBeLessThanOrEqual(120 + 80);
  });

  test('no file: the tail is undefined', async () => {
    expect(await readLogTail(join(dir, 'none.log'), 10)).toBeUndefined();
  });
});
