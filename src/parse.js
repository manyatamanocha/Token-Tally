import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

export const GAP_MS = 900000;
const WRITE_TOOLS = new Set(['Write', 'Edit', 'NotebookEdit']);

export function localDate(ms) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function toSpans(times) {
  const sorted = [...times].sort((a, b) => a - b);
  const spans = [];
  for (const t of sorted) {
    const last = spans[spans.length - 1];
    if (last && t - last[1] <= GAP_MS) last[1] = t;
    else spans.push([t, t]);
  }
  return spans;
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
  const content = Array.isArray(message.content) ? message.content : [];
  for (const block of content) {
    if (block?.type !== 'tool_use') continue;
    const file = block.input?.file_path ?? block.input?.notebook_path;
    if (typeof file !== 'string') continue;
    if (WRITE_TOOLS.has(block.name)) state.writtenFiles.add(file);
    else if (block.name === 'Read') state.readFiles.add(file);
  }
  const usage = message.usage;
  if (!usage || message.model === '<synthetic>') return;
  const id = entry.requestId ?? entry.uuid;
  if (!id) return;
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

function countRoots(files, cwd, resolveRoot) {
  const counts = {};
  for (const file of files) {
    const root = resolveRoot(file, cwd);
    if (root) counts[root] = (counts[root] ?? 0) + 1;
  }
  return counts;
}

export function summarize(state, sessionId, resolveRoot, subagents, skipRequest = () => false) {
  const byDay = {};
  const byModel = {};
  const requestIds = [];
  for (const [id, r] of state.requests) {
    if (skipRequest(id)) continue;
    requestIds.push(id);
    const day = (byDay[localDate(r.time)] ??= { newTokens: 0, rereadTokens: 0, requests: 0 });
    day.newTokens += r.newTokens;
    day.rereadTokens += r.rereadTokens;
    day.requests += 1;
    const model = (byModel[r.model] ??= { newTokens: 0, rereadTokens: 0 });
    model.newTokens += r.newTokens;
    model.rereadTokens += r.rereadTokens;
  }
  const spans = toSpans(state.times);
  return {
    sessionId,
    startedAt: spans[0]?.[0] ?? 0,
    lastAt: spans[spans.length - 1]?.[1] ?? 0,
    spans,
    byDay,
    byModel,
    subagents,
    written: countRoots(state.writtenFiles, state.cwd, resolveRoot),
    read: countRoots(state.readFiles, state.cwd, resolveRoot),
    cwdRoot: state.cwd ? resolveRoot(state.cwd, state.cwd) : null,
    requestIds,
  };
}

export async function parseSession({ sessionId, mainPath, subagentPaths = [], resolveRoot, skipRequest }) {
  const state = {
    times: [], cwd: null, requests: new Map(), writtenFiles: new Set(), readFiles: new Set(),
  };
  for (const path of [mainPath, ...subagentPaths].filter(Boolean)) await readLog(path, state);
  return summarize(state, sessionId, resolveRoot, subagentPaths.length, skipRequest);
}
