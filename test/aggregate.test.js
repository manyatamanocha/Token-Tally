process.env.TZ = 'UTC';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newRecord } from '../src/record.js';
import { buildDashboard, sessionShares, UNSORTED } from '../src/aggregate.js';

const H = 3600000;
const T0 = Date.parse('2026-10-01T10:00:00Z');
const session = (id, o = {}) => {
  const spans = o.spans ?? [[T0, T0 + H]];
  return {
    sessionId: id, startedAt: spans[0][0], lastAt: spans.at(-1)[1], spans,
    byDay: o.byDay ?? { '2026-10-01': { newTokens: 100, rereadTokens: 1000, requests: 10 } },
    byModel: o.byModel ?? { m: { newTokens: 100, rereadTokens: 1000 } },
    subagents: o.subagents ?? 0, written: o.written ?? {}, read: o.read ?? {}, cwdRoot: o.cwdRoot ?? null,
  };
};
const dash = (sessions, overrides = {}, now = T0 + 1000 * H) => {
  const record = newRecord();
  for (const s of sessions) record.sessions[s.sessionId] = s;
  Object.assign(record.overrides, overrides);
  return buildDashboard(record, now);
};
const find = (d, id) => d.products.find((p) => p.id === id);

test('6, 3 and 1 written files give 0.6, 0.3 and 0.1', () => {
  const s = sessionShares(session('s', { written: { a: 6, b: 3, c: 1 } }), newRecord().overrides);
  assert.deepEqual(s, { a: 0.6, b: 0.3, c: 0.1 });
});
test('read files count only when nothing was written', () => {
  const o = newRecord().overrides;
  assert.deepEqual(sessionShares(session('s', { written: { a: 1 }, read: { b: 9 } }), o), { a: 1 });
  assert.deepEqual(sessionShares(session('s', { read: { b: 9 } }), o), { b: 1 });
});
test('cwdRoot is used when no files were touched', () => {
  assert.deepEqual(sessionShares(session('s', { cwdRoot: 'a' }), newRecord().overrides), { a: 1 });
});
test('a session with no signal goes to Not sorted yet', () => {
  const d = dash([session('s')]);
  assert.equal(d.products.length, 0);
  assert.equal(d.unsorted.name, 'Not sorted yet');
  assert.equal(d.unsorted.id, UNSORTED);
});
test('assign override wins over file signals', () => {
  const d = dash([session('s', { written: { a: 1 } })], { assign: { s: 'b' } });
  assert.equal(find(d, 'b').agents, 1);
  assert.equal(find(d, 'a'), undefined);
});
test('tokens split by share', () => {
  const d = dash([session('s', { written: { a: 3, b: 1 } })]);
  assert.equal(find(d, 'a').newTokens, 75);
  assert.equal(find(d, 'b').rereadTokens, 250);
});
test('a split session counts as 1 agent in each product', () => {
  const d = dash([session('s', { written: { a: 3, b: 1 } })]);
  assert.equal(find(d, 'a').agents, 1);
  assert.equal(find(d, 'b').agents, 1);
});
test('a split session counts its full subagents in each product', () => {
  const d = dash([session('s', { subagents: 4, written: { a: 3, b: 1 } })]);
  assert.equal(find(d, 'b').subagents, 4);
});
test('days counts only dates with work on that product', () => {
  const d = dash([
    session('s1', { written: { a: 1 }, byDay: { '2026-10-01': { newTokens: 1, rereadTokens: 1, requests: 1 } } }),
    session('s2', { written: { a: 1 }, byDay: { '2026-10-31': { newTokens: 1, rereadTokens: 1, requests: 1 } } }),
  ]);
  assert.equal(find(d, 'a').days, 2);
});
test('a day with only user messages still counts', () => {
  const d = dash([session('s1', { written: { a: 1 }, byDay: {} })]);
  assert.equal(find(d, 'a').days, 1);
});
test('overlapping sessions count one hour one time', () => {
  const d = dash([session('s1', { written: { a: 1 } }), session('s2', { written: { a: 1 } })]);
  assert.equal(find(d, 'a').hours, 1);
  assert.equal(find(d, 'a').agents, 2);
});
test('hours use the highest share active at each moment', () => {
  const d = dash([
    session('s1', { written: { a: 1, b: 1 }, spans: [[T0, T0 + 2 * H]] }),
    session('s2', { written: { a: 1 }, spans: [[T0 + H, T0 + 2 * H]] }),
  ]);
  assert.equal(find(d, 'a').hours, 1.5);
  assert.equal(find(d, 'b').hours, 1);
});
test('merge joins two roots', () => {
  const d = dash([session('s1', { written: { a: 1 } }), session('s2', { written: { b: 1 } })], { merges: { b: 'a' } });
  assert.equal(d.products.length, 1);
  assert.equal(find(d, 'a').agents, 2);
});
test('merge follows a chain', () => {
  const d = dash([session('s1', { written: { c: 1 } })], { merges: { c: 'b', b: 'a' } });
  assert.equal(find(d, 'a').agents, 1);
});
test('a merge loop does not hang', () => {
  const d = dash([session('s1', { written: { a: 1 } })], { merges: { a: 'b', b: 'a' } });
  assert.equal(d.products.length, 1);
});
test('rename changes the name, not the id', () => {
  const d = dash([session('s', { written: { '/x/app': 1 } })], { names: { '/x/app': 'Hamsty' } });
  assert.equal(d.products[0].id, '/x/app');
  assert.equal(d.products[0].name, 'Hamsty');
});
test('name defaults to the last folder name', () => {
  assert.equal(dash([session('s', { written: { '/x/app': 1 } })]).products[0].name, 'app');
});
test('hidden product leaves products and enters hidden', () => {
  const d = dash([session('s', { written: { '/x/app': 1 } })], { hidden: ['/x/app'] });
  assert.equal(d.products.length, 0);
  assert.deepEqual(d.hidden, [{ id: '/x/app', name: 'app' }]);
});
test('rereadPerRequest is 0 when requests is 0', () => {
  const d = dash([session('s', { written: { a: 1 }, byDay: {} })]);
  assert.equal(find(d, 'a').rereadPerRequest, 0);
});
test('rereadPerRequest divides re-read tokens by requests', () => {
  assert.equal(find(dash([session('s', { written: { a: 1 } })]), 'a').rereadPerRequest, 100);
});
test('topSessions holds at most 5, largest first', () => {
  const many = [1, 2, 3, 4, 5, 6, 7].map((n) => session(`s${n}`, {
    written: { a: 1 }, byDay: { '2026-10-01': { newTokens: n, rereadTokens: 0, requests: 1 } },
  }));
  const top = find(dash(many), 'a').topSessions;
  assert.equal(top.length, 5);
  assert.equal(top[0].sessionId, 's7');
  assert.deepEqual(Object.keys(top[0]).sort(), ['date', 'newTokens', 'requests', 'rereadTokens', 'sessionId']);
});
test('perDay and perModel are filled', () => {
  const p = find(dash([session('s', { written: { a: 1 } })]), 'a');
  assert.deepEqual(p.perDay, [{ date: '2026-10-01', newTokens: 100, rereadTokens: 1000 }]);
  assert.deepEqual(p.perModel, [{ model: 'm', newTokens: 100, rereadTokens: 1000 }]);
});
test('current is the product active in the last 10 minutes, else null', () => {
  const s = session('s', { written: { a: 1 } });
  assert.equal(dash([s], {}, T0 + H + 60000).current.id, 'a');
  assert.equal(dash([s], {}, T0 + 2 * H).current, null);
});
test('a live session with no product shows Not sorted yet as current', () => {
  assert.equal(dash([session('s')], {}, T0 + H + 60000).current.name, 'Not sorted yet');
});
test('joined lists each joined product with its target', () => {
  const d = dash([session('s', { written: { '/x/a': 1 } })], { merges: { '/x/b': '/x/a' }, names: { '/x/a': 'App' } });
  assert.deepEqual(d.joined, [{ from: '/x/b', name: 'b', into: 'App' }]);
});
test('assigned lists each assigned session', () => {
  const d = dash([session('s')], { assign: { s: '/x/a' } });
  assert.deepEqual(d.assigned, [{ sessionId: 's', date: '2026-10-01', into: 'a' }]);
});
test('an empty record gives empty products', () => {
  const d = dash([]);
  assert.deepEqual([d.products, d.unsorted, d.current, d.sessionCount], [[], null, null, 0]);
});
