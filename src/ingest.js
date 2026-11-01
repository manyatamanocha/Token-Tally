import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { canReadZst, parseCodexSession } from './codex.js';
import { mergeSpans, parseSession, rollUp, PATH_FIELDS } from './parse.js';
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

function findCodexSessions(dir, sessions = new Map()) {
  for (const item of listDir(dir)) {
    const path = join(dir, item.name);
    if (item.isDirectory()) findCodexSessions(path, sessions);
    else if (item.isFile() && /\.jsonl(\.zst)?$/.test(item.name)) {
      const id = item.name.match(/[0-9a-f]{8}-[0-9a-f-]{27}/)?.[0] ?? item.name.replace(/\.jsonl(\.zst)?$/, '');
      const sessionId = `codex-${id}`;
      if (!sessions.has(sessionId) || item.name.endsWith('.jsonl')) sessions.set(sessionId, { sessionId, mainPath: path, subagentPaths: [], llm: 'codex' });
    }
  }
  return sessions;
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

function unionKeys(a = {}, b = {}) {
  const result = {};
  for (const source of [a, b]) {
    for (const [root, keys] of Object.entries(source)) result[root] = [...new Set([...(result[root] ?? []), ...keys])];
  }
  return result;
}

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
    path: stored.path ? Object.fromEntries(PATH_FIELDS.map((f) => [f, Math.max(stored.path[f] ?? 0, parsed.path[f] ?? 0)])) : parsed.path,
    fileKeys: unionKeys(stored.fileKeys, parsed.fileKeys),
  };
}

export async function ingest({ projectsDir, codexDir, record, home }) {
  const resolveRoot = (path, options) => findRoot(path, { home, ...options });
  const claude = existsSync(projectsDir) ? findSessions(projectsDir) : [];
  const codexAll = codexDir && existsSync(codexDir) ? [...findCodexSessions(codexDir).values()] : [];
  const zstOk = canReadZst();
  const codex = codexAll.filter((s) => zstOk || !s.mainPath.endsWith('.zst'));
  const skipped = codexAll.length - codex.length;
  const found = [...claude, ...codex]
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
      parsed = session.llm === 'codex'
        ? await parseCodexSession({ sessionId, path: session.mainPath, resolveRoot, skipRequest })
        : await parseSession({ ...session, resolveRoot, skipRequest });
    } catch {
      continue; // One unreadable log must not stop the other sessions.
    }
    Object.assign(record.seen, states);
    changed = true;
    if (!parsed.spans.length) continue;
    record.sessions[sessionId] = mergeFacts(record.sessions[sessionId], parsed);
    for (const id of Object.keys(parsed.requests)) record.requestOwner[id] = sessionId;
  }
  return { changed, sessions: Object.keys(record.sessions).length, skipped };
}

function oldest(states) {
  const times = Object.values(states).map((s) => s.mtimeMs);
  return times.length ? Math.min(...times) : 0;
}
