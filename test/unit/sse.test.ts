import { describe, expect, test } from 'vitest';
import { parseSse } from '../../src/backends/sse';

function streamOf(...chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(c) {
      for (const ch of chunks) {
        c.enqueue(enc.encode(ch));
      }
      c.close();
    },
  });
}

async function collect(s: ReadableStream<Uint8Array>): Promise<string[]> {
  const out: string[] = [];
  for await (const d of parseSse(s)) {
    out.push(d);
  }
  return out;
}

describe('parseSse', () => {
  test('splits events across chunk boundaries', async () => {
    expect(await collect(streamOf('data: {"a"', ':1}\n\n'))).toEqual(['{"a":1}']);
  });
  test('handles CRLF', async () => {
    expect(await collect(streamOf('data: one\r\n\r\ndata: two\r\n\r\n'))).toEqual(['one', 'two']);
  });
  test('ignores comment lines starting with ":"', async () => {
    expect(await collect(streamOf(': keepalive\n\ndata: x\n\n'))).toEqual(['x']);
  });
  test('joins multi-line data with \\n', async () => {
    expect(await collect(streamOf('data: a\ndata: b\n\n'))).toEqual(['a\nb']);
  });
  test('stops at [DONE]', async () => {
    expect(await collect(streamOf('data: a\n\ndata: [DONE]\n\ndata: b\n\n'))).toEqual(['a']);
  });
  test('flushes a final event without a trailing blank line', async () => {
    expect(await collect(streamOf('data: a\n\ndata: tail'))).toEqual(['a', 'tail']);
  });
});
