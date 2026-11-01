import { existsSync } from 'node:fs';
import { dirname, extname, join, sep } from 'node:path';

const CONTAINERS = new Set(['Documents', 'Desktop', 'Downloads', 'Projects', 'projects', 'code', 'dev', 'src']);
const IGNORED_TOP = ['/tmp', '/private/tmp', '/private/var', '/var/folders'];

function isInside(path, parent) {
  return path === parent || path.startsWith(parent + sep);
}

export function findRoot(filePath, { home, exists = existsSync }) {
  if (IGNORED_TOP.some((p) => isInside(filePath, p))) return null;
  if (isInside(filePath, join(home, '.claude')) || isInside(filePath, join(home, 'Library'))) return null;
  if (filePath === home) return null;

  const start = extname(filePath) ? dirname(filePath) : filePath;
  const inHome = isInside(filePath, home);
  for (let dir = start; dir !== dirname(dir); dir = dirname(dir)) {
    if (inHome && dir === home) break;
    if (exists(join(dir, '.git'))) return dir;
  }
  if (!inHome) return null;

  const parts = start.slice(home.length).split(sep).filter(Boolean);
  let current = home;
  for (const part of parts) {
    current = join(current, part);
    if (CONTAINERS.has(part) || exists(join(current, '.obsidian'))) continue;
    return current;
  }
  return null;
}
