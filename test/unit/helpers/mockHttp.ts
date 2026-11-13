import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface MockRequest {
  url: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
  headers: Record<string, string>;
}

export interface MockResponse {
  status?: number;
  sse?: string[];
  json?: unknown;
}

export async function startMockHttp(
  handler: (req: { url: string; body: any }) => MockResponse, // eslint-disable-line @typescript-eslint/no-explicit-any
): Promise<{ url: string; requests: MockRequest[]; close(): Promise<void> }> {
  const requests: MockRequest[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      const body = text ? JSON.parse(text) : undefined;
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) {
        headers[k] = Array.isArray(v) ? v.join(', ') : (v ?? '');
      }
      const url = req.url ?? '';
      requests.push({ url, body, headers });
      const r = handler({ url, body });
      const status = r.status ?? 200;
      if (r.sse) {
        res.writeHead(status, { 'content-type': 'text/event-stream' });
        for (const s of r.sse) {
          res.write(`data: ${s}\n\n`);
        }
        res.end();
      } else if (r.json !== undefined) {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(r.json));
      } else {
        res.writeHead(status);
        res.end();
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
