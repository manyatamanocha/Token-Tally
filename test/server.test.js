import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer, createRefresher } from '../src/server.js';

let dir, app, opts;
let nextPort = 49300 + Math.floor(Math.random() * 500);
const port = () => { nextPort += 20; return nextPort; };

function call(url, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, headers }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode, text }));
    });
    req.on('error', reject);
    req.end(body);
  });
}
const post = (body, headers = {}) => call(`${app.url}/api/override`, {
  method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', ...headers },
});

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ps-server-'));
  opts = { recordPath: join(dir, 'record.json'), projectsDir: join(dir, 'projects'), home: dir, port: port(), intervalMs: 20 };
  mkdirSync(opts.projectsDir);
  app = await startServer(opts);
});
afterEach(() => app.close());

test('binds to 127.0.0.1 only', () => assert.ok(app.url.startsWith('http://127.0.0.1:')));
test('GET / returns the page', async () => {
  const res = await call(`${app.url}/`);
  assert.equal(res.status, 200);
  assert.match(res.text, /<title>/);
});
test('GET /api/data returns the payload', async () => {
  const res = await call(`${app.url}/api/data`);
  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(res.text).products, []);
});
test('new logs appear without a restart', async () => {
  mkdirSync(join(opts.projectsDir, 'p'));
  writeFileSync(join(opts.projectsDir, 'p', 's1.jsonl'), JSON.stringify({
    type: 'assistant', timestamp: '2026-10-01T10:00:00Z', requestId: 'r', cwd: '/n',
    message: { model: 'm', usage: { input_tokens: 1, output_tokens: 1 }, content: [] },
  }) + '\n');
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(JSON.parse((await call(`${app.url}/api/data`)).text).sessionCount, 1);
});
test('a request with a foreign Host header gets 403', async () => {
  assert.equal((await call(`${app.url}/api/data`, { headers: { Host: 'evil.example' } })).status, 403);
});
test('POST with a foreign Origin gets 403', async () => {
  assert.equal((await post({ action: 'hide', id: 'a' }, { Origin: 'https://evil.example' })).status, 403);
});
test('POST without a JSON content type gets 415', async () => {
  const res = await call(`${app.url}/api/override`, { method: 'POST', body: '{}', headers: { 'content-type': 'text/plain' } });
  assert.equal(res.status, 415);
});
test('POST /api/override rename is saved to the record', async () => {
  assert.equal((await post({ action: 'rename', id: '/x', name: 'Hamsty' })).status, 200);
  assert.equal(JSON.parse(readFileSync(opts.recordPath, 'utf8')).overrides.names['/x'], 'Hamsty');
});
test('merge, hide, unhide and assign are saved', async () => {
  await post({ action: 'merge', from: 'b', to: 'a' });
  await post({ action: 'hide', id: 'c' });
  await post({ action: 'hide', id: 'd' });
  await post({ action: 'unhide', id: 'c' });
  await post({ action: 'assign', sessionId: 's', id: 'a' });
  const { overrides } = JSON.parse(readFileSync(opts.recordPath, 'utf8'));
  assert.deepEqual(overrides.merges, { b: 'a' });
  assert.deepEqual(overrides.hidden, ['d']);
  assert.deepEqual(overrides.assign, { s: 'a' });
});
test('unmerge and unassign undo a change', async () => {
  await post({ action: 'merge', from: 'b', to: 'a' });
  await post({ action: 'assign', sessionId: 's', id: 'a' });
  assert.equal((await post({ action: 'unmerge', from: 'b' })).status, 200);
  assert.equal((await post({ action: 'unassign', sessionId: 's' })).status, 200);
  const { overrides } = JSON.parse(readFileSync(opts.recordPath, 'utf8'));
  assert.deepEqual([overrides.merges, overrides.assign], [{}, {}]);
});
test('a recovered record is reported in the payload', async () => {
  const path = join(dir, 'broken.json');
  writeFileSync(path, '{broken');
  const other = await startServer({ ...opts, recordPath: path, port: port() });
  const data = JSON.parse((await call(`${other.url}/api/data`)).text);
  other.close();
  assert.match(data.notice, /broken\.json\.bad-/);
});
test('an unknown action gets 400', async () => assert.equal((await post({ action: 'drop' })).status, 400));
test('a missing field gets 400', async () => assert.equal((await post({ action: 'rename', id: '/x' })).status, 400));
test('invalid JSON gets 400', async () => {
  const res = await call(`${app.url}/api/override`, { method: 'POST', body: '{', headers: { 'content-type': 'application/json' } });
  assert.equal(res.status, 400);
});
test('a busy port moves to the next port', async () => {
  const busy = port();
  const blocker = net.createServer().listen(busy, '127.0.0.1');
  await new Promise((r) => blocker.once('listening', r));
  const second = await startServer({ ...opts, port: busy });
  assert.equal(second.url, `http://127.0.0.1:${busy + 1}`);
  second.close();
  blocker.close();
});
test('a running token-tally server is reused', async () => {
  const second = await startServer(opts);
  assert.equal(second.alreadyRunning, true);
  assert.equal(second.url, app.url);
  second.close();
  assert.equal((await call(`${app.url}/api/ping`)).status, 200);
});
test('two calls during one ingest run start one ingest', async () => {
  let runs = 0;
  let finish;
  const refresh = createRefresher(() => { runs += 1; return new Promise((r) => { finish = r; }); });
  const a = refresh();
  const b = refresh();
  finish();
  await Promise.all([a, b]);
  assert.equal(runs, 1);
  const c = refresh();
  finish();
  await c;
  assert.equal(runs, 2);
});
