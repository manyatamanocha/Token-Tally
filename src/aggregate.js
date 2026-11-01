import { basename } from 'node:path';
import { localDate } from './parse.js';

export const UNSORTED = '__unsorted__';
const UNSORTED_NAME = 'Not sorted yet';
const CURRENT_WINDOW_MS = 600000;
const TOP_SESSIONS = 5;

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
  return { sessions: [], spans: [], days: new Set(), perDay: {}, perModel: {}, subagents: 0, newTokens: 0, rereadTokens: 0, requests: 0, lastAt: 0 };
}

function addSession(bucket, facts, share) {
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
  bucket.subagents += facts.subagents;
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

function toStats(id, name, b) {
  const round = (usage) => ({ newTokens: Math.round(usage.newTokens), rereadTokens: Math.round(usage.rereadTokens) });
  return {
    id,
    name,
    days: b.days.size,
    hours: weightedHours(b.spans),
    agents: b.sessions.length,
    subagents: b.subagents,
    requests: Math.round(b.requests),
    ...round(b),
    rereadPerRequest: b.requests ? Math.round(b.rereadTokens / b.requests) : 0,
    perDay: Object.entries(b.perDay).sort(([a], [c]) => a.localeCompare(c)).map(([date, u]) => ({ date, ...round(u) })),
    perModel: Object.entries(b.perModel).map(([model, u]) => ({ model, ...round(u) }))
      .sort((a, c) => c.newTokens + c.rereadTokens - a.newTokens - a.rereadTokens),
    topSessions: [...b.sessions].sort((a, c) => c.newTokens + c.rereadTokens - a.newTokens - a.rereadTokens).slice(0, TOP_SESSIONS),
    lastAt: b.lastAt,
  };
}

export function buildDashboard(record, now) {
  const { overrides } = record;
  const buckets = new Map();
  const sessions = Object.values(record.sessions);
  let latest = null;
  for (const facts of sessions) {
    if (!latest || facts.lastAt > latest.lastAt) latest = facts;
    const shares = sessionShares(facts, overrides);
    const entries = Object.keys(shares).length ? Object.entries(shares) : [[UNSORTED, 1]];
    for (const [id, share] of entries) {
      if (!buckets.has(id)) buckets.set(id, emptyBucket());
      addSession(buckets.get(id), facts, share);
    }
  }

  const nameOf = (id) => overrides.names[id] ?? (id === UNSORTED ? UNSORTED_NAME : basename(id));
  const all = [...buckets].map(([id, b]) => toStats(id, nameOf(id), b)).sort((a, b) => b.lastAt - a.lastAt);
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
    sessionCount: sessions.length,
  };
}
