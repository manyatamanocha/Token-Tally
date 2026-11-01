import http from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildDashboard } from './aggregate.js';
import { ingest } from './ingest.js';
import { loadRecord, saveRecord } from './record.js';

const HOST = '127.0.0.1';
const PORT_TRIES = 11;
const MAX_BODY = 64 * 1024;
const PAGE_PATH = fileURLToPath(new URL('../public/index.html', import.meta.url));

export function createRefresher(run) {
  let active = null;
  return () => {
    active ??= (async () => run())().finally(() => { active = null; });
    return active;
  };
}

const isText = (...values) => values.every((v) => typeof v === 'string' && v.length > 0 && v.length <= 4096);

function applyOverride(overrides, body) {
  const { action, id, name, from, to, sessionId } = body;
  if (action === 'rename' && isText(id, name)) overrides.names[id] = name;
  else if (action === 'merge' && isText(from, to) && from !== to) overrides.merges[from] = to;
  else if (action === 'hide' && isText(id)) overrides.hidden = [...new Set([...overrides.hidden, id])];
  else if (action === 'unhide' && isText(id)) overrides.hidden = overrides.hidden.filter((h) => h !== id);
  else if (action === 'assign' && isText(sessionId, id)) overrides.assign[sessionId] = id;
  else if (action === 'unmerge' && isText(from)) delete overrides.merges[from];
  else if (action === 'unassign' && isText(sessionId)) delete overrides.assign[sessionId];
  else return false;
  return true;
}

function allowedHost(value) {
  if (!value) return false;
  const name = value.replace(/:\d+$/, '');
  return name === HOST || name === 'localhost';
}

function allowedOrigin(origin) {
  if (!origin) return true;
  try {
    return allowedHost(new URL(origin).host);
  } catch {
    return false;
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) reject(new Error('too large'));
      else chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function send(res, status, body, type = 'application/json') {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

function listen(server, port) {
  return new Promise((resolve, reject) => {
    const onError = (error) => { server.off('listening', onListening); reject(error); };
    const onListening = () => { server.off('error', onError); resolve(); };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, HOST);
  });
}

function isOurServer(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: HOST, port, path: '/api/ping', timeout: 1000 }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => resolve(text.includes('"product-stats"')));
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

export async function startServer({ recordPath, projectsDir, home, port = 4477, intervalMs = 5000 }) {
  const record = loadRecord(recordPath);
  let syncing = true;
  const notice = record.recovered
    ? `Your saved numbers could not be read, so the tool started again from the logs that still exist. The old file is at ${record.recovered}`
    : null;
  const refresh = createRefresher(async () => {
    const { changed } = await ingest({ projectsDir, record, home });
    if (changed) saveRecord(recordPath, record);
    syncing = false;
  });

  const server = http.createServer(async (req, res) => {
    if (!allowedHost(req.headers.host) || !allowedOrigin(req.headers.origin)) return send(res, 403, { error: 'forbidden' });
    const path = req.url.split('?')[0];
    if (req.method === 'GET' && path === '/') return send(res, 200, readFileSync(PAGE_PATH, 'utf8'), 'text/html; charset=utf-8');
    if (req.method === 'GET' && path === '/api/ping') return send(res, 200, { app: 'product-stats' });
    if (req.method === 'GET' && path === '/api/data') return send(res, 200, { ...buildDashboard(record, Date.now()), syncing, notice });
    if (req.method === 'POST' && path === '/api/override') {
      if (!req.headers['content-type']?.startsWith('application/json')) return send(res, 415, { error: 'send JSON' });
      try {
        if (!applyOverride(record.overrides, JSON.parse(await readBody(req)))) return send(res, 400, { error: 'invalid change' });
      } catch {
        return send(res, 400, { error: 'invalid request' });
      }
      saveRecord(recordPath, record);
      return send(res, 200, { ok: true });
    }
    return send(res, 404, { error: 'not found' });
  });

  for (let p = port; p < port + PORT_TRIES; p += 1) {
    if (await isOurServer(p)) return { url: `http://${HOST}:${p}`, alreadyRunning: true, close() {} };
    try {
      await listen(server, p);
      const timer = setInterval(() => refresh().catch(() => {}), intervalMs);
      refresh().catch(() => {});
      return {
        url: `http://${HOST}:${p}`,
        alreadyRunning: false,
        close() {
          clearInterval(timer);
          server.close();
          server.closeAllConnections();
        },
      };
    } catch (error) {
      if (error.code !== 'EADDRINUSE') throw error;
    }
  }
  throw new Error(`Ports ${port} to ${port + PORT_TRIES - 1} are in use. Close another program and try again.`);
}
