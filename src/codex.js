import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import * as zlib from 'node:zlib';
import { newState, summarize } from './parse.js';

const MARKERS = ['"session_meta"', '"turn_context"', '"token_usage_record"', '"user_message"', '"function_call"', '"custom_tool_call"', '"item_completed"', '"turn_aborted"', '"token_count"'];

export const canReadZst = () => typeof zlib.createZstdDecompress === 'function';

function openLog(path) {
  const file = createReadStream(path);
  if (!path.endsWith('.zst')) return file;
  const unzip = zlib.createZstdDecompress();
  file.on('error', (error) => unzip.destroy(error));
  return file.pipe(unzip);
}

function readItem(item, state) {
  if (item?.type === 'UserMessage') {
    // Codex adds other UserMessage items itself. Only typed messages have a client_id.
    if (item.client_id) state.typedItems += 1;
  } else if (item?.type === 'FileChange') {
    state.path.edits += 1;
    const changes = item.changes;
    if (changes && typeof changes === 'object' && !Array.isArray(changes)) for (const file of Object.keys(changes)) state.writtenFiles.add(file);
  } else if (item?.type === 'WebSearch') {
    state.path.web += 1;
  } else if (item?.type === 'CommandExecution') {
    for (const part of item.parsed_cmd ?? []) {
      if (part?.type !== 'read' && part?.type !== 'search') continue;
      state.path.reads += 1;
      if (typeof part.path === 'string' && part.path.startsWith('/')) state.readFiles.add(part.path);
    }
  }
}

function readUsage(payload, time, model, state) {
  const id = payload.response_id;
  const usage = payload.usage;
  if (!id || !usage) return;
  const requestId = `codex:${id}`;
  if (state.skipRequest(requestId)) {
    state.lastCopiedAt = Math.max(state.lastCopiedAt, time);
    return;
  }
  if (state.requests.has(requestId)) return;
  const cached = usage.cached_input_tokens ?? 0;
  state.requests.set(requestId, {
    time,
    model: model ?? 'unknown',
    output: usage.output_tokens ?? 0,
    newTokens: Math.max(0, (usage.input_tokens ?? 0) - cached) + (usage.output_tokens ?? 0),
    rereadTokens: cached,
  });
}

// Older logs have token_count events only. Each rise in the running total is one request.
function readCounts(counts, sessionId, state) {
  let seen = -1;
  counts.forEach((c, n) => {
    const total = c.info.total_token_usage?.total_tokens ?? 0;
    const last = c.info.last_token_usage;
    if (total <= seen || !last) return;
    seen = total;
    const id = `${sessionId}:${n}`;
    if (state.skipRequest(id)) return;
    const cached = last.cached_input_tokens ?? 0;
    state.requests.set(id, {
      time: c.time,
      model: c.model ?? 'unknown',
      output: last.output_tokens ?? 0,
      newTokens: Math.max(0, (last.input_tokens ?? 0) - cached) + (last.output_tokens ?? 0),
      rereadTokens: cached,
    });
  });
}

export async function parseCodexSession({ sessionId, path, resolveRoot, skipRequest = () => false }) {
  const state = newState(skipRequest);
  let model = null;
  let isSubagent = false;
  state.typedItems = 0;
  const counts = [];
  const lines = createInterface({ input: openLog(path), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!MARKERS.some((m) => line.includes(m))) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue; // Codex may still be writing this line.
    }
    const payload = entry.payload && typeof entry.payload === 'object' ? entry.payload : {};
    const time = Date.parse(entry.timestamp);
    if (Number.isNaN(time)) continue;
    const kind = payload.type;
    if (entry.type === 'session_meta') {
      state.cwd ??= payload.cwd ?? null;
      isSubagent ||= Boolean(payload.parent_thread_id);
      continue;
    }
    if (entry.type === 'turn_context') {
      model = payload.model ?? model;
      continue;
    }
    state.times.push(time);
    if (entry.type === 'token_usage_record') readUsage(payload, time, model, state);
    else if (kind === 'token_count') { if (payload.info) counts.push({ info: payload.info, time, model }); }
    else if (kind === 'user_message') state.messageTimes.push(time);
    else if (kind === 'turn_aborted') state.stopTimes.push(time);
    else if (kind === 'item_completed') readItem(payload.item, state);
    else if (kind === 'function_call' || kind === 'custom_tool_call') {
      state.path.actions += 1;
      if (payload.name === 'exec') state.path.commands += 1;
      else state.path.other += 1;
    }
  }
  if (!state.requests.size) readCounts(counts, sessionId, state);
  state.path.actions += state.path.edits;
  if (state.typedItems) state.path.messages = state.typedItems - state.messageTimes.length; // Newer logs: items replace user_message events.
  return summarize(state, sessionId, resolveRoot, 0, { llm: 'codex', isSubagent });
}
