import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadRecord, saveRecord, newRecord } from '../src/record.js';
import { ingest } from '../src/ingest.js';

let dir, projectsDir, recordPath, home;
const line = (id, output, cache = 100) => JSON.stringify({
  type: 'assistant', timestamp: '2026-10-01T10:00:00.000Z', requestId: id, cwd: '/nowhere',
  message: { model: 'm', usage: { input_tokens: 1, output_tokens: output, cache_creation_input_tokens: 0, cache_read_input_tokens: cache }, content: [] },
});
const writeLog = (name, lines) => writeFileSync(join(projectsDir, 'p', `${name}.jsonl`), lines.join('\n') + '\n');
const requests = (facts) => Object.values(facts.byDay).reduce((n, d) => n + d.requests, 0);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ps-'));
  projectsDir = join(dir, 'projects');
  home = join(dir, 'home');
  mkdirSync(join(projectsDir, 'p'), { recursive: true });
  mkdirSync(home);
  recordPath = join(dir, 'state', 'record.json');
});

const lineAt = (id, time, cache = 100) => line(id, 5, cache).replace('2026-10-01T10:00:00.000Z', time);
const userAt = (time) => JSON.stringify({ type: 'user', timestamp: time, cwd: '/nowhere', message: { content: 'x' } });
const addSubagent = (session, lines) => {
  const folder = join(projectsDir, 'p', session, 'subagents');
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, 'agent-1.jsonl'), lines.join('\n') + '\n');
};
const dayTotal = (facts, key) => Object.values(facts.byDay).reduce((n, d) => n + d[key], 0);

test('deleted subagent logs keep totals when the main log grows past them', async () => {
  writeLog('s1', [line('r1', 5, 100)]);
  addSubagent('s1', [line('s1', 5, 1000000), line('s2', 5, 1000000), line('s3', 5, 1000000)]);
  const record = newRecord();
  await ingest({ projectsDir, record, home });
  rmSync(join(projectsDir, 'p', 's1'), { recursive: true });
  writeLog('s1', [line('r1', 5, 100), line('r2', 5, 100), line('r3', 5, 100), line('r4', 5, 100)]);
  await ingest({ projectsDir, record, home });
  assert.equal(requests(record.sessions.s1), 7);
  assert.equal(dayTotal(record.sessions.s1, 'rereadTokens'), 3000300 + 100);
  assert.equal(record.sessions.s1.subagents, 1);
});
test('new requests count after subagent logs are deleted', async () => {
  writeLog('s1', [lineAt('r1', '2026-10-01T10:00:00.000Z')]);
  addSubagent('s1', [line('s1', 5), line('s2', 5), line('s3', 5)]);
  const record = newRecord();
  await ingest({ projectsDir, record, home });
  rmSync(join(projectsDir, 'p', 's1'), { recursive: true });
  writeLog('s1', [lineAt('r1', '2026-10-01T10:00:00.000Z'), lineAt('r2', '2026-10-20T10:00:00.000Z')]);
  await ingest({ projectsDir, record, home });
  assert.equal(requests(record.sessions.s1), 5);
  assert.equal(Object.keys(record.sessions.s1.byDay).length, 2);
});
test('spans from deleted logs stay', async () => {
  writeLog('s1', [lineAt('r1', '2026-10-01T10:00:00.000Z'), lineAt('r2', '2026-10-01T10:10:00.000Z'), lineAt('r3', '2026-10-01T10:20:00.000Z')]);
  const record = newRecord();
  await ingest({ projectsDir, record, home });
  writeLog('s1', [lineAt('r9', '2026-10-01T10:21:00.000Z')]);
  await ingest({ projectsDir, record, home });
  const [[start, end]] = record.sessions.s1.spans;
  assert.equal(end - start, 21 * 60000);
});
test('a resumed session does not add old days', async () => {
  writeLog('s1', [userAt('2026-10-01T10:00:00.000Z'), lineAt('r1', '2026-10-01T10:01:00.000Z')]);
  const record = newRecord();
  await ingest({ projectsDir, record, home });
  writeLog('s2', [userAt('2026-10-01T10:00:00.000Z'), lineAt('r1', '2026-10-01T10:01:00.000Z'), userAt('2026-10-20T10:00:00.000Z'), lineAt('r2', '2026-10-20T10:01:00.000Z')]);
  await ingest({ projectsDir, record, home });
  assert.deepEqual(Object.keys(record.sessions.s2.byDay), ['2026-10-20']);
  assert.equal(record.sessions.s2.spans.length, 1);
  assert.equal(new Date(record.sessions.s2.startedAt).getUTCDate(), 20);
});
test('a log with no usable lines is not a session', async () => {
  writeLog('s1', ['{"type":"summary"}']);
  const record = newRecord();
  await ingest({ projectsDir, record, home });
  assert.deepEqual(record.sessions, {});
});
test('an unreadable log does not stop other sessions', async () => {
  writeLog('s1', [line('r1', 5)]);
  mkdirSync(join(projectsDir, 'p', 's1', 'subagents', 'bad.jsonl'), { recursive: true });
  writeLog('s2', [line('r2', 5)]);
  const record = newRecord();
  await ingest({ projectsDir, record, home });
  assert.ok(record.sessions.s2);
});

test('new record has no sessions', () => {
  assert.deepEqual(loadRecord(recordPath).sessions, {});
});
test('saves with a temp file and rename', () => {
  saveRecord(recordPath, newRecord());
  assert.equal(JSON.parse(readFileSync(recordPath, 'utf8')).version, 3);
  assert.deepEqual(readdirSync(join(dir, 'state')), ['record.json']);
});
test('a corrupt record is kept and reported, and a new one starts', () => {
  saveRecord(recordPath, newRecord());
  writeFileSync(recordPath, '{broken');
  const record = loadRecord(recordPath);
  assert.deepEqual(record.sessions, {});
  assert.equal(readFileSync(record.recovered, 'utf8'), '{broken');
});
test('two corrupt records keep two copies', async () => {
  saveRecord(recordPath, newRecord());
  writeFileSync(recordPath, '{one');
  loadRecord(recordPath);
  await new Promise((r) => setTimeout(r, 5));
  writeFileSync(recordPath, '{two');
  loadRecord(recordPath);
  assert.equal(readdirSync(join(dir, 'state')).filter((f) => f.includes('.bad-')).length, 2);
});
test('a read error does not reset the record', () => {
  mkdirSync(recordPath, { recursive: true });
  assert.throws(() => loadRecord(recordPath));
  assert.ok(existsSync(recordPath));
});
test('a newer record version stops and keeps the file', () => {
  saveRecord(recordPath, { ...newRecord(), version: 4 });
  assert.throws(() => loadRecord(recordPath), /newer version/);
  assert.equal(JSON.parse(readFileSync(recordPath, 'utf8')).version, 4);
});
test('the recovered path is not saved', () => {
  saveRecord(recordPath, { ...newRecord(), recovered: '/x' });
  assert.equal(JSON.parse(readFileSync(recordPath, 'utf8')).recovered, undefined);
});
test('ingest reads a session and removes requestIds', async () => {
  writeLog('s1', [line('r1', 5)]);
  const record = newRecord();
  const result = await ingest({ projectsDir, record, home });
  assert.deepEqual(result, { changed: true, sessions: 1, skipped: 0 });
  assert.equal(requests(record.sessions.s1), 1);
  assert.equal(record.sessions.s1.requestIds, undefined);
  assert.equal(record.requestOwner.r1, 's1');
});
test('reads subagent logs with the session', async () => {
  writeLog('s1', [line('r1', 5)]);
  mkdirSync(join(projectsDir, 'p', 's1', 'subagents'), { recursive: true });
  writeFileSync(join(projectsDir, 'p', 's1', 'subagents', 'agent-1.jsonl'), line('r2', 5) + '\n');
  const record = newRecord();
  await ingest({ projectsDir, record, home });
  assert.equal(record.sessions.s1.subagents, 1);
  assert.equal(requests(record.sessions.s1), 2);
});
test('second ingest skips unchanged logs', async () => {
  writeLog('s1', [line('r1', 5)]);
  const record = newRecord();
  await ingest({ projectsDir, record, home });
  assert.equal((await ingest({ projectsDir, record, home })).changed, false);
});
test('deleted log keeps its session numbers', async () => {
  writeLog('s1', [line('r1', 5)]);
  const record = newRecord();
  await ingest({ projectsDir, record, home });
  rmSync(join(projectsDir, 'p', 's1.jsonl'));
  await ingest({ projectsDir, record, home });
  assert.equal(requests(record.sessions.s1), 1);
});
test('a log that shrinks does not reduce a session', async () => {
  writeLog('s1', [line('r1', 5), line('r2', 5)]);
  const record = newRecord();
  await ingest({ projectsDir, record, home });
  writeLog('s1', [line('r1', 5)]);
  await ingest({ projectsDir, record, home });
  assert.equal(requests(record.sessions.s1), 2);
});
test('a resumed session does not double count a requestId', async () => {
  writeLog('s1', [line('r1', 5)]);
  writeLog('s2', [line('r1', 5), line('r2', 5)]);
  const record = newRecord();
  await ingest({ projectsDir, record, home });
  assert.equal(requests(record.sessions.s1) + requests(record.sessions.s2), 2);
});
test('a growing session keeps its own requests', async () => {
  writeLog('s1', [line('r1', 5)]);
  const record = newRecord();
  await ingest({ projectsDir, record, home });
  writeLog('s1', [line('r1', 5), line('r2', 5)]);
  await ingest({ projectsDir, record, home });
  assert.equal(requests(record.sessions.s1), 2);
});
test('a missing projects folder gives zero sessions, no error', async () => {
  assert.deepEqual(await ingest({ projectsDir: join(dir, 'none'), record: newRecord(), home }), { changed: false, sessions: 0, skipped: 0 });
});
test('person overrides stay after ingest', async () => {
  writeLog('s1', [line('r1', 5)]);
  const record = newRecord();
  record.overrides.names['/x'] = 'My app';
  await ingest({ projectsDir, record, home });
  assert.equal(record.overrides.names['/x'], 'My app');
});
