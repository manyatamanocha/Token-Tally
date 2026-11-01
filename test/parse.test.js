process.env.TZ = 'Asia/Kolkata';
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { parseSession } from '../src/parse.js';

const path = (p) => fileURLToPath(new URL(p, import.meta.url));
const resolveRoot = (file) => {
  if (file.startsWith('/h/work/app')) return '/h/work/app';
  if (file.startsWith('/h/docs')) return '/h/docs';
  return null;
};
let facts;
before(async () => {
  facts = await parseSession({
    sessionId: 'session-a',
    mainPath: path('fixtures/session-a.jsonl'),
    subagentPaths: [path('fixtures/session-a/subagents/agent-1.jsonl')],
    resolveRoot,
  });
});
const sum = (key) => Object.values(facts.byDay).reduce((n, d) => n + d[key], 0);

test('counts a repeated requestId once, with its final usage', () => {
  assert.equal(sum('requests'), 4);
  assert.equal(facts.byModel['model-a'].newTokens, 165);
});
test('new tokens = input + output + cache creation', () => assert.equal(sum('newTokens'), 175));
test('re-read tokens = cache reads', () => assert.equal(sum('rereadTokens'), 6010));
test('adds subagent tokens and counts 1 subagent', () => {
  assert.equal(facts.subagents, 1);
  assert.deepEqual(facts.byModel['model-b'], { newTokens: 10, rereadTokens: 10 });
});
test('skips a cut-off line without error', () => assert.ok(!('req-x' in facts.requests)));
test('a 20-minute gap makes two spans', () => {
  assert.deepEqual(facts.spans, [
    [Date.parse('2026-10-01T20:00:00Z'), Date.parse('2026-10-01T20:03:00Z')],
    [Date.parse('2026-10-01T20:25:00Z'), Date.parse('2026-10-01T20:25:00Z')],
  ]);
});
test('groups days by local date', () => assert.deepEqual(Object.keys(facts.byDay), ['2026-10-02']));
test('counts a file edited twice as one distinct file', () => {
  assert.deepEqual(facts.written, { '/h/work/app': 3 });
  assert.deepEqual(facts.read, { '/h/docs': 1 });
});
test('records the working folder root', () => assert.equal(facts.cwdRoot, '/h/work/app'));
test('output never contains SECRET-TEXT', () => {
  assert.ok(!JSON.stringify(facts).includes('SECRET-TEXT'));
});
