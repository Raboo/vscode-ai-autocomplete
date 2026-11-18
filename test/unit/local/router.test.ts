import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { LocalModel } from '../../../src/local/modelList';
import { probeRouter, renderPresets, RouterClient, routerArgs, supportsRouter } from '../../../src/local/router';

function model(over: Partial<LocalModel>): LocalModel {
  return {
    name: 'm', label: 'M', repo: 'r/r', revision: 'abc', file: 'm.gguf', bytes: 1, sha256: 'x',
    uses: ['completions'], contextTokens: 8192, extraArgs: [], builtIn: true, hidden: false, ...over,
  };
}

const sweep = model({ name: 'sweep-next-edit-1.5b', uses: ['nextEdit', 'completions'], extraArgs: ['--threads', '8'] });
const mellum = model({ name: 'mellum-4b-base' });
const base = '/Users/x/Library/Application Support/m';
const pathOf = (m: LocalModel) => `${base}/${m.name === sweep.name ? 'sweep' : 'mellum'}.gguf`;

describe('renderPresets', () => {
  it('renders the sections', () => {
    expect(renderPresets([sweep, mellum], pathOf)).toBe(`version = 1

[*]
ngl = 99
fa = on
cache-reuse = 256

[sweep-next-edit-1.5b]
model = ${base}/sweep.gguf
c = 16384
np = 2
threads = 8

[mellum-4b-base]
model = ${base}/mellum.gguf
c = 8192
np = 1
`);
  });
  it('refuses line breaks in paths and values', () => {
    for (const bad of ['\n', '\r', '\u0085', '\u2028', '\u2029']) {
      expect(() => renderPresets([mellum], () => `/a${bad}b`)).toThrow();
      expect(() => renderPresets([model({ extraArgs: ['--x', `a${bad}b`] })], pathOf)).toThrow();
    }
  });
  it('refuses unsafe section names', () => {
    for (const name of ['a]b', '[a', 'a\nb']) expect(() => renderPresets([model({ name })], pathOf)).toThrow();
  });
});

describe('routerArgs and supportsRouter', () => {
  it('builds the argument array', () => {
    expect(routerArgs({ presetsPath: '/p.ini', modelsMax: 2, port: 9000 })).toEqual([
      '--models-preset', '/p.ini', '--models-max', '2', '--host', '127.0.0.1', '--port', '9000', '--no-webui',
    ]);
  });
  it('detects router support', () => {
    expect(supportsRouter('  --models-preset PATH  presets')).toBe(true);
    expect(supportsRouter('--port N')).toBe(false);
  });
});

let server: Server | undefined;
afterEach(() => new Promise<void>((r) => (server ? server.close(() => r()) : r())).then(() => (server = undefined)));

async function serve(handler: (req: IncomingMessage, res: ServerResponse, body: string) => void): Promise<number> {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => handler(req, res, body));
  });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  return (server.address() as AddressInfo).port;
}
const json = (res: ServerResponse, v: unknown, code = 200) => {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(v));
};

describe('RouterClient', () => {
  it('maps model states and calls the endpoints', async () => {
    const seen: string[] = [];
    const port = await serve((req, res, body) => {
      seen.push(`${req.method} ${req.url} ${body}`);
      if (req.url === '/props') return json(res, { role: 'router' });
      if (req.url?.startsWith('/models') && req.method === 'GET')
        return json(res, { data: [
          { id: 'a', status: { value: 'loaded' } },
          { id: 'b', status: { value: 'loading' } },
          { id: 'c', status: { value: 'unloaded' } },
          { id: 'd', status: { value: 'sleeping' } },
          { id: 'e', status: { value: 'unloaded', failed: true, exit_code: 1 } },
          { id: 'f', status: { value: 'downloading' } },
        ] });
      json(res, { success: true });
    });
    const c = new RouterClient(`http://127.0.0.1:${port}`);
    expect(await c.isRouter()).toBe(true);
    expect((await c.models()).map((m) => `${m.id}:${m.state}`)).toEqual(
      ['a:loaded', 'b:loading', 'c:unloaded', 'd:sleeping', 'e:failed', 'f:unloaded']);
    await c.load('x');
    await c.unload('x');
    await c.reload();
    expect(seen).toContain('POST /models/load {"model":"x"}');
    expect(seen).toContain('POST /models/unload {"model":"x"}');
    expect(seen).toContain('GET /models?reload=1 ');
  });
  it('throws a fixed message on failure', async () => {
    const port = await serve((_q, res) => json(res, { error: 'secret body' }, 500));
    const c = new RouterClient(`http://127.0.0.1:${port}`);
    await expect(c.models()).rejects.toThrow(/^router request failed \(500\)$/);
    expect(await c.isRouter()).toBe(false);
  });
});

describe('probeRouter', () => {
  const handler = (role: string | undefined, ids: string[], health = 200) => (req: IncomingMessage, res: ServerResponse) => {
    if (req.url === '/health') return json(res, { status: 'ok' }, health);
    if (req.url === '/props') return json(res, role ? { role } : { total_slots: 1 });
    json(res, { data: ids.map((id) => ({ id, status: { value: 'unloaded' } })) });
  };
  it('ours', async () => {
    const port = await serve(handler('router', ['a', 'b', 'c']));
    expect(await probeRouter(port, ['a', 'b'])).toBe('ours');
  });
  it('none for a plain server or a missing name', async () => {
    let port = await serve(handler(undefined, ['a']));
    expect(await probeRouter(port, ['a'])).toBe('none');
    await new Promise<void>((r) => server!.close(() => r()));
    port = await serve(handler('router', ['a']));
    expect(await probeRouter(port, ['a', 'b'])).toBe('none');
  });
  it('loading on 503', async () => {
    const port = await serve(handler('router', [], 503));
    expect(await probeRouter(port, ['a'])).toBe('loading');
  });
  it('none when nothing listens', async () => {
    const port = await serve(handler('router', []));
    await new Promise<void>((r) => server!.close(() => r()));
    expect(await probeRouter(port, ['a'])).toBe('none');
  });
});
