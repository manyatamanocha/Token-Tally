import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parseSession } from './parse.js';
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

const totalRequests = (facts) => Object.values(facts.byDay).reduce((n, d) => n + d.requests, 0);

export async function ingest({ projectsDir, record, home }) {
  if (!existsSync(projectsDir)) return { changed: false, sessions: 0 };
  const resolveRoot = (file) => findRoot(file, { home });
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
    changed = true;
    Object.assign(record.seen, states);

    const skipRequest = (id) => record.requestOwner[id] && record.requestOwner[id] !== session.sessionId;
    const { requestIds, ...facts } = await parseSession({ ...session, resolveRoot, skipRequest });
    const stored = record.sessions[session.sessionId];
    if (stored && totalRequests(facts) < totalRequests(stored)) continue;
    record.sessions[session.sessionId] = facts;
    for (const id of requestIds) record.requestOwner[id] = session.sessionId;
  }
  return { changed, sessions: Object.keys(record.sessions).length };
}

function oldest(states) {
  const times = Object.values(states).map((s) => s.mtimeMs);
  return times.length ? Math.min(...times) : 0;
}
