import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as zlib from 'node:zlib';
import { buildAdvice, replaySaving, sessionAdvice } from '../src/advice.js';
import { buildDashboard } from '../src/aggregate.js';
import { parseCodexSession } from '../src/codex.js';
import { ingest } from '../src/ingest.js';
import { parseSession } from '../src/parse.js';
import { loadRecord, moveOldState, newRecord, saveRecord } from '../src/record.js';

let dir, projectsDir, codexDir, home, recordPath;
const T = '2026-10-01T10:00:00.000Z';
const user = (content, extra = {}, timestamp = T) => JSON.stringify({ type: 'user', timestamp, cwd: '/nowhere', message: { content }, ...extra });
const assistant = (id, blocks = [], timestamp = T) => JSON.stringify({
  type: 'assistant', timestamp, requestId: id, message: { model: 'claude-x', usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100 }, content: blocks },
});
const tool = (name, input = {}, id = `t-${name}`) => ({ type: 'tool_use', id, name, input });
const cx = (type, payload, timestamp = T) => JSON.stringify({ timestamp, type, payload });
const codexLog = (file, lines) => writeFileSync(file, lines.join('\n') + '\n');
const codexLines = (id = 'r1', cwd = '/nowhere') => [
  cx('session_meta', { cwd, id: 's' }),
  cx('turn_context', { model: 'gpt-x' }),
  cx('event_msg', { type: 'user_message', message: 'secret chat phrase' }),
  cx('response_item', { type: 'custom_tool_call', name: 'exec', input: 'secret command' }),
  cx('event_msg', { type: 'item_completed', item: { type: 'FileChange', changes: { '/h/work/app/a.js': {} } } }),
  cx('event_msg', { type: 'item_completed', item: { type: 'CommandExecution', parsed_cmd: [{ type: 'read', path: '/h/work/app/b.js' }] } }),
  cx('token_usage_record', { response_id: id, usage: { input_tokens: 100, cached_input_tokens: 60, output_tokens: 20 } }),
  cx('token_usage_record', { response_id: id, usage: { input_tokens: 100, cached_input_tokens: 60, output_tokens: 20 } }),
];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'st-'));
  projectsDir = join(dir, 'projects');
  codexDir = join(dir, 'codex');
  home = join(dir, 'home');
  for (const d of [join(projectsDir, 'p'), join(codexDir, '2026', '10', '01'), home]) mkdirSync(d, { recursive: true });
  recordPath = join(dir, 'record.json');
});

test('Claude path counts sort tools and skip system messages', async () => {
  const log = join(dir, 'a.jsonl');
  writeFileSync(log, [
    user('build this'), user('<system-reminder>x</system-reminder>'), user('meta', { isMeta: true }),
    user('[Request interrupted by user]'), user([{ type: 'tool_result', content: 'x' }]),
    assistant('r1', [tool('Read', { file_path: '/a' }), tool('Edit', { file_path: '/h/work/app/a.js' }), tool('Bash'), tool('WebSearch'), tool('Agent'), tool('Skill')]),
  ].join('\n'));
  const f = await parseSession({ sessionId: 's', mainPath: log, resolveRoot: (p) => (p.startsWith('/h/work/app') ? '/h/work/app' : null) });
  assert.deepEqual(f.path, { messages: 1, stops: 1, actions: 6, reads: 1, edits: 1, commands: 1, web: 1, other: 1, delegated: 1 });
  assert.equal(f.llm, 'claude');
  assert.equal(JSON.stringify(f).includes('a.js'), false);
});

test('a resumed Claude session does not count copied messages twice', async () => {
  writeFileSync(join(projectsDir, 'p', 'one.jsonl'), [user('first'), assistant('r1')].join('\n'));
  const record = newRecord();
  await ingest({ projectsDir, record, home });
  writeFileSync(join(projectsDir, 'p', 'two.jsonl'), [user('first'), assistant('r1'), user('next', {}, '2026-10-02T10:00:00.000Z')].join('\n'));
  await ingest({ projectsDir, record, home });
  assert.equal(record.sessions.two.path.messages, 1);
});

test('the Codex reader counts tokens once and keeps no chat text', async () => {
  const log = join(dir, 'c.jsonl');
  codexLog(log, codexLines());
  const f = await parseCodexSession({ sessionId: 'codex-1', path: log, resolveRoot: (p) => (p.startsWith('/h/work/app') ? '/h/work/app' : null) });
  assert.equal(f.llm, 'codex');
  assert.equal(f.byModel['gpt-x'].newTokens, 60);
  assert.equal(f.byModel['gpt-x'].rereadTokens, 60);
  assert.deepEqual(f.written, { '/h/work/app': 1 });
  assert.deepEqual(f.read, { '/h/work/app': 1 });
  assert.equal(f.path.messages, 1);
  assert.equal(f.path.commands, 1);
  assert.equal(f.path.actions, 2);
  assert.equal(f.path.reads, 1);
  assert.equal(JSON.stringify(f).includes('secret'), false);
});

test('Codex typed messages count once when both record kinds exist', async () => {
  const log = join(dir, 'd.jsonl');
  codexLog(log, [
    cx('event_msg', { type: 'user_message', message: 'a' }),
    cx('event_msg', { type: 'item_completed', item: { type: 'UserMessage', client_id: 'c1' } }),
    cx('event_msg', { type: 'item_completed', item: { type: 'UserMessage', client_id: 'c2' } }),
    cx('event_msg', { type: 'item_completed', item: { type: 'UserMessage' } }),
  ]);
  const f = await parseCodexSession({ sessionId: 'x', path: log, resolveRoot: () => null });
  assert.equal(f.path.messages, 2);
});

test('older Codex logs use token_count events, once for each rise', async () => {
  const log = join(dir, 'e.jsonl');
  const count = (total, input) => cx('event_msg', { type: 'token_count', info: { total_token_usage: { total_tokens: total }, last_token_usage: { input_tokens: input, cached_input_tokens: 10, output_tokens: 5 } } });
  codexLog(log, [cx('turn_context', { model: 'gpt-old' }), count(100, 30), count(100, 30), count(200, 50)]);
  const f = await parseCodexSession({ sessionId: 'y', path: log, resolveRoot: () => null });
  assert.equal(f.byModel['gpt-old'].newTokens, 70);
  assert.equal(f.byModel['gpt-old'].rereadTokens, 20);
  assert.equal(Object.keys(f.requests).length, 2);
});

test('a Codex session with a parent counts as a subagent', async () => {
  const log = join(codexDir, 'rollout-01a18e57-d850-7ea2-85b1-1afefc9625c3.jsonl');
  codexLog(log, [cx('session_meta', { cwd: '/nowhere', parent_thread_id: 'x' }), ...codexLines().slice(1)]);
  const record = newRecord();
  await ingest({ projectsDir, codexDir, record, home });
  const d = buildDashboard(record, Date.parse(T));
  assert.equal(d.totals.agents, 0);
  assert.equal(d.totals.subagents, 1);
});

test('compressed Codex logs are read, and a damaged log does not stop the others', { skip: typeof zlib.zstdCompressSync !== 'function' }, async () => {
  const folder = join(codexDir, '2026', '10', '01');
  const good = zlib.zstdCompressSync(Buffer.from(codexLines('r2').join('\n') + '\n'));
  writeFileSync(join(folder, 'rollout-01a18e57-d850-7ea2-85b1-1afefc9625c3.jsonl.zst'), good);
  writeFileSync(join(folder, 'rollout-01a18e58-a120-7f51-a27f-fe97cb8eb767.jsonl.zst'), 'not zstd data');
  codexLog(join(folder, 'rollout-01a19261-4ab1-7c50-bcb6-0591c3a8726e.jsonl'), [...codexLines('r3'), '{"half a li']);
  const record = newRecord();
  const result = await ingest({ projectsDir, codexDir, record, home });
  assert.equal(result.sessions, 2);
});

test('Claude and Codex stay separate, and All equals their sum', async () => {
  writeFileSync(join(projectsDir, 'p', 'one.jsonl'), [user('hi'), assistant('r1')].join('\n'));
  codexLog(join(codexDir, 'rollout-01a18e57-d850-7ea2-85b1-1afefc9625c3.jsonl'), codexLines('r9'));
  const record = newRecord();
  await ingest({ projectsDir, codexDir, record, home });
  const at = Date.parse(T);
  const [all, a, b] = [null, 'claude', 'codex'].map((llm) => buildDashboard(record, at, llm));
  assert.equal(a.totals.newTokens, 15);
  assert.equal(b.totals.newTokens, 60);
  assert.equal(all.totals.newTokens, a.totals.newTokens + b.totals.newTokens);
  assert.equal(all.totals.agents, 2);
  assert.deepEqual(all.tape.map((r) => r.llm).sort(), ['claude', 'codex']);
});

test('one file edited in two sessions counts once', async () => {
  const edit = tool('Edit', { file_path: join(home, 'work', 'app', 'a.js') });
  writeFileSync(join(projectsDir, 'p', 'one.jsonl'), assistant('r1', [{ ...edit, id: 'e1' }]));
  writeFileSync(join(projectsDir, 'p', 'two.jsonl'), assistant('r2', [{ ...edit, id: 'e2' }]));
  const record = newRecord();
  await ingest({ projectsDir, record, home });
  assert.equal(buildDashboard(record, 0).totals.files, 1);
});

test('a version 1 record upgrades, keeps totals and reads logs again', async () => {
  const session = { sessionId: 'old', byDay: { '2026-10-01': { newTokens: 500, rereadTokens: 9, requests: 2 } }, byModel: {}, requests: {}, spans: [[1, 2]], startedAt: 1, lastAt: 2, subagents: 0, written: {}, read: {}, cwdRoot: null };
  saveRecord(recordPath, { ...newRecord(), version: 1, sessions: { old: session }, seen: { a: { mtimeMs: 1, size: 1 } } });
  const record = loadRecord(recordPath);
  assert.equal(record.version, 2);
  assert.deepEqual(record.seen, {});
  assert.equal(record.sessions.old.llm, 'claude');
  const d = buildDashboard(record, 0);
  assert.equal(d.totals.newTokens, 500);
  assert.equal(d.totals.pathMissing, 1);
  assert.equal(JSON.parse(readFileSync(recordPath, 'utf8')).version, 1);
});

const facts = (steps, reread, path = {}, model = 'gpt-x', extra = {}) => ({
  byDay: { '2026-10-01': { requests: steps, newTokens: steps * 5000, rereadTokens: reread } },
  byModel: { [model]: { newTokens: steps * 5000 } }, path, lastAt: 1, ...extra,
});

const growing = (steps, size = 1000) => Object.fromEntries(Array.from({ length: steps }, (_, i) => [`r${i}`, [i, 'm', 5000, (i + 1) * size]]));

test('the replay matches a hand count', () => {
  const requests = growing(600);
  const base = 5500;
  let expected = 0;
  for (let i = 300; i < 600; i += 1) expected += 1000 * (i + 1) - Math.max(base, 1000 * (i + 1) - 1000 * (i - (i % 300) + 1) + base);
  assert.equal(replaySaving({ requests }), expected);
});

test('a long chat that never grows has no saving and no tip', () => {
  const requests = Object.fromEntries(Array.from({ length: 600 }, (_, i) => [`r${i}`, [i, 'm', 5000, 1000]]));
  const a = sessionAdvice(facts(600, 600000, {}, 'm', { requests }));
  assert.equal(a.saved, 0);
  assert.deepEqual(a.tips, []);
});

test('a long growing chat gets a tested saving', () => {
  const a = sessionAdvice(facts(600, 1200000, {}, 'm', { requests: growing(600) }));
  assert.equal(a.saved > 0, true);
  assert.equal(a.tips[0].tested, true);
  assert.match(a.tips[0].text, /A replay with a new chat every 300 steps saved about/);
});

test('a short chat gets no saving and no tip', () => {
  const a = sessionAdvice(facts(100, 1000000, { messages: 5, actions: 100 }));
  assert.equal(a.saved, 0);
  assert.deepEqual(a.tips, []);
});

test('the untested tips show no saving and say Idea', () => {
  const small = facts(120, 1000, { messages: 80, actions: 100, stops: 4 }, 'claude-opus-x');
  small.byDay['2026-10-01'].newTokens = 12000;
  small.byModel['claude-opus-x'].newTokens = 12000;
  const { tips, saved } = sessionAdvice(small);
  assert.deepEqual(tips.map((x) => x.kind), ['short-messages', 'large-model', 'stops']);
  assert.equal(saved, 0);
  assert.equal(tips.every((x) => x.text.startsWith('Idea:') && x.tested === false), true);
});

test('advice lists the latest session and the biggest savings', () => {
  const a = buildAdvice([facts(600, 1200000, {}, 'm', { lastAt: 1, requests: growing(600) }), facts(10, 100, {}, 'm', { lastAt: 9 })], () => ({ product: 'p' }));
  assert.equal(a.latest.at, 9);
  assert.equal(a.worst.length, 1);
  assert.equal(a.longChats, 1);
  assert.equal(a.longChatShare > 0.99, true);
});

test('files changed in five sessions are counted', () => {
  const list = [1, 2, 3, 4, 5].map((n) => facts(10, 10, {}, 'm', { lastAt: n, fileKeys: { '/p': ['same'] } }));
  assert.equal(buildAdvice(list, () => ({})).repeatedFiles, 1);
});

test('the old folder is copied once and kept', () => {
  const [from, to] = [join(dir, 'old'), join(dir, 'new')];
  mkdirSync(from);
  writeFileSync(join(from, 'record.json'), '{}');
  assert.equal(moveOldState(from, to), true);
  assert.equal(readFileSync(join(to, 'record.json'), 'utf8'), '{}');
  assert.equal(readFileSync(join(from, 'record.json'), 'utf8'), '{}');
  assert.equal(moveOldState(from, to), false);
});
