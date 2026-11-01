import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { mergeSpans, parseSession, rollUp } from './parse.js';
import { findRoot } from './roots.js';

function listDir(path) {
  try {
    return readdirSync(path, { withFileTypes: true });
  } catch {
    return [];
  }
}

function findSessions(projectsDir) {
  const sessions = new Map();
  const entry = (id) => {
    if (!sessions.has(id)) sessions.set(id, { sessionId: id, mainPath: null, subagentPaths: [] });
    return sessions.get(id);
  };
  for (const project of listDir(projectsDir)) {
    if (!project.isDirectory()) continue;
    const projectPath = join(projectsDir, project.name);
    for (const item of listDir(projectPath)) {
      if (item.isFile() && item.name.endsWith('.jsonl')) {
        entry(item.name.slice(0, -'.jsonl'.length)).mainPath = join(projectPath, item.name);
      } else if (item.isDirectory()) {
        const dir = join(projectPath, item.name, 'subagents');
        for (const log of listDir(dir)) {
          if (log.name.endsWith('.jsonl')) entry(item.name).subagentPaths.push(join(dir, log.name));
        }
      }
    }
  }
  return [...sessions.values()];
}

function fileStates(session) {
  const states = {};
  for (const path of [session.mainPath, ...session.subagentPaths].filter(Boolean)) {
    try {
      const { mtimeMs, size } = statSync(path);
      states[path] = { mtimeMs, size };
    } catch {
      // The log was deleted after the folder was listed.
    }
  }
  return states;
}

const higher = (a, b) => {
  const result = { ...a };
  for (const [key, value] of Object.entries(b)) result[key] = Math.max(result[key] ?? 0, value);
  return result;
};

// Numbers only grow. A log that Claude Code deleted can never reduce what the record holds.
function mergeFacts(stored, parsed) {
  if (!stored) return parsed;
  const requests = { ...stored.requests };
  for (const [id, value] of Object.entries(parsed.requests)) {
    if (!requests[id] || value[2] >= requests[id][2]) requests[id] = value;
  }
  const spans = mergeSpans([...stored.spans, ...parsed.spans]);
  return {
    ...parsed,
    startedAt: spans[0]?.[0] ?? 0,
    lastAt: spans[spans.length - 1]?.[1] ?? 0,
    spans,
    ...rollUp(requests),
    requests,
    subagents: Math.max(stored.subagents, parsed.subagents),
    written: higher(stored.written, parsed.written),
    read: higher(stored.read, parsed.read),
    cwdRoot: stored.cwdRoot ?? parsed.cwdRoot,
  };
}

export async function ingest({ projectsDir, record, home }) {
  if (!existsSync(projectsDir)) return { changed: false, sessions: 0 };
  const resolveRoot = (path, options) => findRoot(path, { home, ...options });
  const found = findSessions(projectsDir)
    .map((session) => ({ session, states: fileStates(session) }))
    .sort((a, b) => oldest(a.states) - oldest(b.states));

  let changed = false;
  for (const { session, states } of found) {
    const isChanged = Object.entries(states).some(([path, s]) => {
      const seen = record.seen[path];
      return !seen || seen.mtimeMs !== s.mtimeMs || seen.size !== s.size;
    });
    if (!isChanged) continue;

    const { sessionId } = session;
    const skipRequest = (id) => record.requestOwner[id] && record.requestOwner[id] !== sessionId;
    let parsed;
    try {
      parsed = await parseSession({ ...session, resolveRoot, skipRequest });
    } catch {
      continue; // One unreadable log must not stop the other sessions.
    }
    Object.assign(record.seen, states);
    changed = true;
    if (!parsed.spans.length) continue;
    record.sessions[sessionId] = mergeFacts(record.sessions[sessionId], parsed);
    for (const id of Object.keys(parsed.requests)) record.requestOwner[id] = sessionId;
  }
  return { changed, sessions: Object.keys(record.sessions).length };
}

function oldest(states) {
  const times = Object.values(states).map((s) => s.mtimeMs);
  return times.length ? Math.min(...times) : 0;
}
