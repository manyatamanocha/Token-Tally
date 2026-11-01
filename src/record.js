import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const VERSION = 2;

export function newRecord() {
  return {
    version: VERSION,
    sessions: {},
    requestOwner: {},
    seen: {},
    overrides: { names: {}, merges: {}, hidden: [], assign: {} },
  };
}

// Version 1 knew Claude only. Clearing `seen` reads each log once more to fill the new counts.
function upgradeFromV1(old) {
  const sessions = Object.fromEntries(Object.entries(old.sessions).map(([id, s]) => [id, { ...s, llm: 'claude' }]));
  return { ...newRecord(), ...old, version: VERSION, sessions, seen: {} };
}

export function loadRecord(path) {
  if (!existsSync(path)) return newRecord();
  const text = readFileSync(path, 'utf8'); // A read error stops here and keeps the file.
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  if (parsed?.version > VERSION) throw new Error(`${path} was made by a newer version of this tool. Update the tool.`);
  if (parsed?.version === VERSION) return { ...newRecord(), ...parsed };
  if (parsed?.version === 1) return upgradeFromV1(parsed);
  const recovered = `${path}.bad-${Date.now()}`;
  renameSync(path, recovered);
  return { ...newRecord(), recovered };
}

export function saveRecord(path, record) {
  mkdirSync(dirname(path), { recursive: true });
  const { recovered, ...stored } = record;
  const temp = `${path}.${process.pid}.tmp`;
  const file = openSync(temp, 'w');
  try {
    writeSync(file, JSON.stringify(stored));
    fsyncSync(file);
  } finally {
    closeSync(file);
  }
  renameSync(temp, path);
}
