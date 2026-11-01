import { basename } from 'node:path';
import { emptyPath, localDate, PATH_FIELDS } from './parse.js';

export const UNSORTED = '__unsorted__';
const UNSORTED_NAME = 'Not sorted yet';
const CURRENT_WINDOW_MS = 600000;
const TOP_SESSIONS = 5;
const UNSORTED_SESSIONS = 20;
const TAPE_SIZE = 40;

function resolveMerge(root, merges) {
  const visited = new Set([root]);
  let current = root;
  while (merges[current] && !visited.has(merges[current])) {
    current = merges[current];
    visited.add(current);
  }
  return current;
}

function normalize(counts) {
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  return Object.fromEntries(Object.entries(counts).map(([k, v]) => [k, v / total]));
}

export function sessionShares(facts, overrides) {
  const assigned = overrides.assign[facts.sessionId];
  let counts;
  if (assigned) counts = { [assigned]: 1 };
  else if (Object.keys(facts.written).length) counts = facts.written;
  else if (Object.keys(facts.read).length) counts = facts.read;
  else if (facts.cwdRoot) counts = { [facts.cwdRoot]: 1 };
  else return {};

  const merged = {};
  for (const [root, count] of Object.entries(counts)) {
    const target = resolveMerge(root, overrides.merges);
    merged[target] = (merged[target] ?? 0) + count;
  }
  return normalize(merged);
}

function weightedHours(spans) {
  const points = [...new Set(spans.flatMap(({ start, end }) => [start, end]))].sort((a, b) => a - b);
  let ms = 0;
  for (let i = 0; i < points.length - 1; i += 1) {
    const [from, to] = [points[i], points[i + 1]];
    let highest = 0;
    for (const s of spans) if (s.start <= from && s.end >= to && s.share > highest) highest = s.share;
    ms += (to - from) * highest;
  }
  return ms / 3600000;
}

function emptyBucket() {
  return { sessions: [], spans: [], days: new Set(), perDay: {}, perModel: {}, subagents: 0, mainAgents: 0, newTokens: 0, rereadTokens: 0, requests: 0, lastAt: 0, path: emptyPath(), pathMissing: 0, files: new Set() };
}

function sessionFiles(facts, id, overrides) {
  const byRoot = Object.entries(facts.fileKeys ?? {});
  if (id === null || id === UNSORTED || overrides.assign[facts.sessionId]) return byRoot.flatMap(([, keys]) => keys);
  return byRoot.filter(([root]) => root && resolveMerge(root, overrides.merges) === id).flatMap(([, keys]) => keys);
}

function addSession(bucket, facts, share, id, overrides) {
  let newTokens = 0;
  let rereadTokens = 0;
  let requests = 0;
  for (const [date, day] of Object.entries(facts.byDay)) {
    bucket.days.add(date);
    const entry = (bucket.perDay[date] ??= { newTokens: 0, rereadTokens: 0 });
    entry.newTokens += day.newTokens * share;
    entry.rereadTokens += day.rereadTokens * share;
    newTokens += day.newTokens * share;
    rereadTokens += day.rereadTokens * share;
    requests += day.requests * share;
  }
  for (const [model, usage] of Object.entries(facts.byModel)) {
    const entry = (bucket.perModel[model] ??= { newTokens: 0, rereadTokens: 0 });
    entry.newTokens += usage.newTokens * share;
    entry.rereadTokens += usage.rereadTokens * share;
  }
  for (const [start, end] of facts.spans) {
    bucket.spans.push({ start, end, share });
    bucket.days.add(localDate(start));
    bucket.days.add(localDate(end));
  }
  bucket.subagents += facts.subagents + (facts.isSubagent ? 1 : 0);
  bucket.mainAgents += facts.isSubagent ? 0 : 1;
  if (facts.path) for (const f of PATH_FIELDS) bucket.path[f] += (facts.path[f] ?? 0) * share;
  else bucket.pathMissing += 1;
  for (const key of sessionFiles(facts, id, overrides)) bucket.files.add(key);
  bucket.newTokens += newTokens;
  bucket.rereadTokens += rereadTokens;
  bucket.requests += requests;
  bucket.lastAt = Math.max(bucket.lastAt, facts.lastAt);
  bucket.sessions.push({
    sessionId: facts.sessionId,
    date: localDate(facts.startedAt),
    newTokens: Math.round(newTokens),
    rereadTokens: Math.round(rereadTokens),
    requests: Math.round(requests),
  });
}

function toStats(id, name, b, limit = TOP_SESSIONS) {
  const round = (usage) => ({ newTokens: Math.round(usage.newTokens), rereadTokens: Math.round(usage.rereadTokens) });
  return {
    id,
    name,
    days: b.days.size,
    hours: weightedHours(b.spans),
    agents: b.mainAgents,
    subagents: b.subagents,
    path: Object.fromEntries(PATH_FIELDS.map((f) => [f, Math.round(b.path[f])])),
    pathMissing: b.pathMissing,
    files: b.files.size,
    requests: Math.round(b.requests),
    ...round(b),
    rereadPerRequest: b.requests ? Math.round(b.rereadTokens / b.requests) : 0,
    perDay: Object.entries(b.perDay).sort(([a], [c]) => a.localeCompare(c)).map(([date, u]) => ({ date, ...round(u) })),
    perModel: Object.entries(b.perModel).map(([model, u]) => ({ model, ...round(u) }))
      .sort((a, c) => c.newTokens + c.rereadTokens - a.newTokens - a.rereadTokens),
    topSessions: [...b.sessions].sort((a, c) => c.newTokens + c.rereadTokens - a.newTokens - a.rereadTokens).slice(0, limit),
    lastAt: b.lastAt,
  };
}

function topProduct(facts, overrides) {
  const [id] = Object.entries(sessionShares(facts, overrides)).sort((a, b) => b[1] - a[1])[0] ?? [UNSORTED];
  return id;
}

function tapeRow(facts, overrides, nameOf) {
  const productId = topProduct(facts, overrides);
  const [model] = Object.entries(facts.byModel).sort((a, b) => b[1].newTokens - a[1].newTokens)[0] ?? ['unknown'];
  const days = Object.values(facts.byDay);
  return {
    at: facts.lastAt,
    llm: facts.llm ?? 'claude',
    productId,
    product: nameOf(productId),
    model,
    steps: days.reduce((a, d) => a + d.requests, 0),
    newTokens: days.reduce((a, d) => a + d.newTokens, 0),
  };
}

export function buildDashboard(record, now, llm = null) {
  const { overrides } = record;
  const buckets = new Map();
  const everything = emptyBucket();
  const sessions = Object.values(record.sessions).filter((s) => !llm || (s.llm ?? 'claude') === llm);
  let latest = null;
  for (const facts of sessions) {
    if (!latest || facts.lastAt > latest.lastAt) latest = facts;
    const shares = sessionShares(facts, overrides);
    const entries = Object.keys(shares).length ? Object.entries(shares) : [[UNSORTED, 1]];
    for (const [id, share] of entries) {
      if (!buckets.has(id)) buckets.set(id, emptyBucket());
      addSession(buckets.get(id), facts, share, id, overrides);
    }
    addSession(everything, facts, 1, null, overrides);
  }

  const nameOf = (id) => overrides.names[id] ?? (id === UNSORTED ? UNSORTED_NAME : basename(id));
  const all = [...buckets].map(([id, b]) => toStats(id, nameOf(id), b, id === UNSORTED ? UNSORTED_SESSIONS : TOP_SESSIONS)).sort((a, b) => b.lastAt - a.lastAt);
  const isHidden = (p) => overrides.hidden.includes(p.id);
  const unsorted = all.find((p) => p.id === UNSORTED) ?? null;
  const products = all.filter((p) => p.id !== UNSORTED && !isHidden(p));

  let current = null;
  if (latest && now - latest.lastAt <= CURRENT_WINDOW_MS) {
    const shares = Object.entries(sessionShares(latest, overrides)).sort((a, b) => b[1] - a[1]);
    const id = shares[0]?.[0] ?? UNSORTED;
    current = all.find((p) => p.id === id && !isHidden(p)) ?? null;
  }

  return {
    generatedAt: now,
    current,
    products,
    unsorted,
    hidden: all.filter(isHidden).map(({ id, name }) => ({ id, name })),
    joined: Object.entries(overrides.merges).map(([from, to]) => ({ from, name: nameOf(from), into: nameOf(to) })),
    assigned: Object.entries(overrides.assign).map(([sessionId, id]) => ({
      sessionId,
      date: localDate(record.sessions[sessionId]?.startedAt ?? 0),
      into: nameOf(id),
    })),
    sessionCount: sessions.length,
    totals: toStats('all', 'All products', everything),
    tape: sessions.filter((s) => Object.values(s.byDay).some((d) => d.newTokens > 0)).sort((a, b) => b.lastAt - a.lastAt).slice(0, TAPE_SIZE).map((s) => tapeRow(s, overrides, nameOf)),
  };
}
