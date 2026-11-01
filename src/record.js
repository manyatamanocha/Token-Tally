import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export function newRecord() {
  return {
    version: 1,
    sessions: {},
    requestOwner: {},
    seen: {},
    overrides: { names: {}, merges: {}, hidden: [], assign: {} },
  };
}

export function loadRecord(path) {
  if (!existsSync(path)) return newRecord();
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    if (parsed?.version !== 1) throw new Error('unknown version');
    return { ...newRecord(), ...parsed };
  } catch {
    renameSync(path, `${path}.bad`);
    return newRecord();
  }
}

export function saveRecord(path, record) {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(record));
  renameSync(temp, path);
}
