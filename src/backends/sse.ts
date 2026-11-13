/** Parses a Server-Sent Events body, yielding each event's data. Ends on "[DONE]". */
export async function* parseSse(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let data: string[] = [];

  // Returns the event data and clears it, or undefined if the event had no data lines.
  const take = (): string | undefined => {
    if (data.length === 0) {
      return undefined;
    }
    const d = data.join('\n');
    data = [];
    return d;
  };

  const handleLine = (line: string): { emit?: string; done?: boolean } => {
    if (line === '') {
      const d = take();
      if (d === undefined) {
        return {};
      }
      return d === '[DONE]' ? { done: true } : { emit: d };
    }
    if (line.startsWith(':')) {
      return {};
    }
    const idx = line.indexOf(':');
    const field = idx === -1 ? line : line.slice(0, idx);
    if (field === 'data') {
      let value = idx === -1 ? '' : line.slice(idx + 1);
      if (value.startsWith(' ')) {
        value = value.slice(1);
      }
      data.push(value);
    }
    return {};
  };

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) {
        buf += decoder.decode();
      } else {
        buf += decoder.decode(value, { stream: true });
      }
      let m: RegExpExecArray | null;
      const re = /\r\n|\n|\r/g;
      let start = 0;
      while ((m = re.exec(buf)) !== null) {
        // A trailing lone "\r" may be the first half of "\r\n"; wait for more input.
        if (m[0] === '\r' && m.index === buf.length - 1 && !done) {
          break;
        }
        const r = handleLine(buf.slice(start, m.index));
        start = m.index + m[0].length;
        if (r.done) {
          return;
        }
        if (r.emit !== undefined) {
          yield r.emit;
        }
      }
      buf = buf.slice(start);
      if (done) {
        if (buf !== '') {
          handleLine(buf);
        }
        const d = take();
        if (d !== undefined && d !== '[DONE]') {
          yield d;
        }
        return;
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}
