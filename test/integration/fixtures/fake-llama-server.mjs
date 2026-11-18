#!/usr/bin/env node
// A stand-in llama-server for the local model integration test. `--help` lists `--models-preset` (router mode). Started
// with `--models-preset <file>` it is a router on 127.0.0.1 at the --port it is given: /health, /props (the router's,
// or a model's with ?model=), /models (with ?reload=1), /models/load, /models/unload and /infill (with `a + b;`); the
// models are the section names of the presets file. With FAKE_LLAMA_SERVER_EXIT=1 it exits at once with code 1; with
// FAKE_LLAMA_SERVER_EXIT_ONCE=<path> it does so only while that file exists, deleting it (the next start works). With
// FAKE_LLAMA_SERVER_STARTS=<path> it appends its pid to that file once it listens.
import { appendFileSync, existsSync, readFileSync, unlinkSync } from 'node:fs';
import { createServer } from 'node:http';
import process from 'node:process';
import { URL } from 'node:url';

if (process.argv.includes('--help')) {
  process.stdout.write('usage: llama-server [options]\n  --models-preset PATH   models preset file\n  --models-max N\n');
  process.exit(0);
}

const arg = (name) => {
  const at = process.argv.indexOf(name);
  return at >= 0 ? process.argv[at + 1] : undefined;
};

const exitOnce = process.env.FAKE_LLAMA_SERVER_EXIT_ONCE;
const failNow = process.env.FAKE_LLAMA_SERVER_EXIT === '1' || (exitOnce !== undefined && existsSync(exitOnce));
if (exitOnce !== undefined && existsSync(exitOnce)) unlinkSync(exitOnce);
if (failNow) {
  process.stderr.write('fake llama-server: failed to load the model\n');
  process.exit(1);
}

const port = Number(arg('--port'));
const presetsPath = arg('--models-preset');

/** Section name to slots (`np`), from the presets file. */
const readPresets = () => {
  const models = new Map();
  if (!presetsPath) return models;
  let current;
  for (const line of readFileSync(presetsPath, 'utf8').split('\n')) {
    const section = /^\[(.+)\]$/.exec(line.trim());
    if (section) {
      current = section[1] === '*' ? undefined : section[1];
      if (current) models.set(current, 1);
    } else if (current && /^np\s*=/.test(line)) models.set(current, Number(line.split('=')[1]));
  }
  return models;
};
let models = readPresets();
const loaded = new Set();

const json = (res, status, body) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const path = url.pathname;
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const named = () => {
      try {
        return JSON.parse(body).model;
      } catch {
        return undefined;
      }
    };
    if (path === '/health') {
      json(res, 200, { status: 'ok' });
    } else if (path === '/props') {
      const model = url.searchParams.get('model');
      if (!model) return json(res, 200, { role: 'router', model_path: 'none', n_ctx: 0 });
      if (!models.has(model)) return json(res, 404, { error: { message: 'model not found' } });
      if (!loaded.has(model)) return json(res, 400, { error: { message: 'model is not loaded' } });
      json(res, 200, { model_alias: model, total_slots: models.get(model) });
    } else if (path === '/models' || path === '/v1/models') {
      if (url.searchParams.get('reload') === '1') models = readPresets();
      json(res, 200, { object: 'list', data: [...models.keys()].map((id) => ({ id, object: 'model', status: { value: loaded.has(id) ? 'loaded' : 'unloaded' } })) });
    } else if (path === '/models/load' || path === '/models/unload') {
      const model = named();
      if (!models.has(model)) return json(res, 404, { error: { message: 'model not found' } });
      if (path === '/models/load') loaded.add(model);
      else loaded.delete(model);
      json(res, 200, { success: true });
    } else if (path === '/infill') {
      const model = named();
      if (model !== undefined && models.has(model)) loaded.add(model);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ content: 'a + b;' })}\n\n`);
      res.end(`data: ${JSON.stringify({ content: '', stop: true })}\n\n`);
    } else {
      res.writeHead(404).end();
    }
  });
});

server.listen(port, '127.0.0.1', () => {
  if (process.env.FAKE_LLAMA_SERVER_STARTS) appendFileSync(process.env.FAKE_LLAMA_SERVER_STARTS, `${process.pid}\n`);
  process.stdout.write(`fake llama-server listening on 127.0.0.1:${port}\n`);
});
const stop = () => {
  server.close();
  server.closeAllConnections();
  process.exit(0);
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
