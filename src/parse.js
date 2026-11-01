import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

export const GAP_MS = 900000;
const WRITE_TOOLS = new Set(['Write', 'Edit', 'NotebookEdit']);

export function localDate(ms) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function mergeSpans(spans) {
  const sorted = [...spans].sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const [start, end] of sorted) {
    const last = merged[merged.length - 1];
    if (last && start - last[1] <= GAP_MS) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  return merged;
}

async function readLog(path, state) {
  const lines = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  for await (const line of lines) {
    const relevant = line.includes('"usage"') || line.includes('"tool_use"') || line.includes('"type":"user"');
    if (!relevant) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue; // Claude Code may still be writing this line.
    }
    if (entry.type !== 'user' && entry.type !== 'assistant') continue;
    const time = Date.parse(entry.timestamp);
    if (Number.isNaN(time)) continue;
    state.times.push(time);
    if (state.cwd === null && entry.cwd) state.cwd = entry.cwd;
    if (entry.type === 'assistant') readAssistant(entry, time, state);
  }
}

function readAssistant(entry, time, state) {
  const message = entry.message;
  if (!message || typeof message !== 'object') return;
  const id = entry.requestId ?? entry.uuid;
  if (id && state.skipRequest(id)) {
    state.lastCopiedAt = Math.max(state.lastCopiedAt, time);
    return;
  }
  const content = Array.isArray(message.content) ? message.content : [];
  for (const block of content) {
    if (block?.type !== 'tool_use') continue;
    const file = block.input?.file_path ?? block.input?.notebook_path;
    if (typeof file !== 'string') continue;
    if (WRITE_TOOLS.has(block.name)) state.writtenFiles.add(file);
    else if (block.name === 'Read') state.readFiles.add(file);
  }
  const usage = message.usage;
  if (!usage || message.model === '<synthetic>' || !id) return;
  const known = state.requests.get(id);
  if (!known || (usage.output_tokens ?? 0) >= known.output) {
    state.requests.set(id, {
      time: known?.time ?? time,
      model: message.model ?? 'unknown',
      output: usage.output_tokens ?? 0,
      newTokens: (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0),
      rereadTokens: usage.cache_read_input_tokens ?? 0,
    });
  }
}

function countRoots(files, resolveRoot) {
  const counts = {};
  for (const file of files) {
    const root = resolveRoot(file);
    if (root) counts[root] = (counts[root] ?? 0) + 1;
  }
  return counts;
}

export function rollUp(requests) {
  const byDay = {};
  const byModel = {};
  for (const [time, modelName, newTokens, rereadTokens] of Object.values(requests)) {
    const day = (byDay[localDate(time)] ??= { newTokens: 0, rereadTokens: 0, requests: 0 });
    day.newTokens += newTokens;
    day.rereadTokens += rereadTokens;
    day.requests += 1;
    const model = (byModel[modelName] ??= { newTokens: 0, rereadTokens: 0 });
    model.newTokens += newTokens;
    model.rereadTokens += rereadTokens;
  }
  return { byDay, byModel };
}

function summarize(state, sessionId, resolveRoot, subagents) {
  const requests = {};
  for (const [id, r] of state.requests) requests[id] = [r.time, r.model, r.newTokens, r.rereadTokens];
  // A resumed session copies old messages to the top of its log. Their times are not new work.
  const times = [...state.times.filter((t) => t > state.lastCopiedAt), ...[...state.requests.values()].map((r) => r.time)];
  const spans = mergeSpans(times.map((t) => [t, t]));
  return {
    sessionId,
    startedAt: spans[0]?.[0] ?? 0,
    lastAt: spans[spans.length - 1]?.[1] ?? 0,
    spans,
    ...rollUp(requests),
    requests,
    subagents,
    written: countRoots(state.writtenFiles, resolveRoot),
    read: countRoots(state.readFiles, resolveRoot),
    cwdRoot: state.cwd ? resolveRoot(state.cwd, { folder: true }) : null,
  };
}

export async function parseSession({ sessionId, mainPath, subagentPaths = [], resolveRoot, skipRequest = () => false }) {
  const state = {
    times: [], cwd: null, requests: new Map(), writtenFiles: new Set(), readFiles: new Set(),
    skipRequest, lastCopiedAt: 0,
  };
  for (const path of [mainPath, ...subagentPaths].filter(Boolean)) await readLog(path, state);
  return summarize(state, sessionId, resolveRoot, subagentPaths.length);
}
