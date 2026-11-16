#!/usr/bin/env node
// A stand-in llama-server for the local model integration test: it answers /health, /props, /v1/models and /infill
// (with `a + b;`) on 127.0.0.1 at the --port it is given. With FAKE_LLAMA_SERVER_EXIT=1 it exits at once with code 1.
import { createServer } from 'node:http';
import process from 'node:process';
import { URL } from 'node:url';

const arg = (name) => {
  const at = process.argv.indexOf(name);
  return at >= 0 ? process.argv[at + 1] : undefined;
};

if (process.env.FAKE_LLAMA_SERVER_EXIT === '1') {
  process.stderr.write('fake llama-server: failed to load the model\n');
  process.exit(1);
}

const port = Number(arg('--port'));
const alias = arg('--alias') ?? 'fake';

const server = createServer((req, res) => {
  const path = new URL(req.url ?? '/', 'http://localhost').pathname;
  req.resume();
  req.on('end', () => {
    if (path === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"status":"ok"}');
    } else if (path === '/props') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ model_alias: alias }));
    } else if (path === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ object: 'list', data: [{ id: alias, object: 'model' }] }));
    } else if (path === '/infill') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ content: 'a + b;' })}\n\n`);
      res.end(`data: ${JSON.stringify({ content: '', stop: true })}\n\n`);
    } else {
      res.writeHead(404).end();
    }
  });
});

server.listen(port, '127.0.0.1', () => process.stdout.write(`fake llama-server listening on 127.0.0.1:${port}\n`));
const stop = () => {
  server.close();
  server.closeAllConnections();
  process.exit(0);
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
