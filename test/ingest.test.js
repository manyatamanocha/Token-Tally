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

test('new record has no sessions', () => {
  assert.deepEqual(loadRecord(recordPath).sessions, {});
});
test('saves with a temp file and rename', () => {
  saveRecord(recordPath, newRecord());
  assert.equal(JSON.parse(readFileSync(recordPath, 'utf8')).version, 1);
  assert.deepEqual(readdirSync(join(dir, 'state')), ['record.json']);
});
test('a corrupt record is renamed to .bad and a new one starts', () => {
  saveRecord(recordPath, newRecord());
  writeFileSync(recordPath, '{broken');
  assert.deepEqual(loadRecord(recordPath).sessions, {});
  assert.ok(existsSync(recordPath + '.bad'));
});
test('ingest reads a session and removes requestIds', async () => {
  writeLog('s1', [line('r1', 5)]);
  const record = newRecord();
  const result = await ingest({ projectsDir, record, home });
  assert.deepEqual(result, { changed: true, sessions: 1 });
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
  assert.deepEqual(await ingest({ projectsDir: join(dir, 'none'), record: newRecord(), home }), { changed: false, sessions: 0 });
});
test('person overrides stay after ingest', async () => {
  writeLog('s1', [line('r1', 5)]);
  const record = newRecord();
  record.overrides.names['/x'] = 'My app';
  await ingest({ projectsDir, record, home });
  assert.equal(record.overrides.names['/x'], 'My app');
});
