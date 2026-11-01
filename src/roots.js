import { existsSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';

const CONTAINERS = new Set(['Documents', 'Desktop', 'Downloads', 'Projects', 'projects', 'code', 'dev', 'src']);
const IGNORED_TOP = ['/tmp', '/private/tmp', '/private/var', '/var/folders'];

function isInside(path, parent) {
  return path === parent || path.startsWith(parent + sep);
}

export function findRoot(path, { home, exists = existsSync, folder = false }) {
  if (IGNORED_TOP.some((p) => isInside(path, p))) return null;
  if (isInside(path, join(home, 'Library')) || path === home) return null;
  const inHome = isInside(path, home);
  if (inHome && path.slice(home.length).split(sep).some((part) => part.startsWith('.'))) return null;

  const start = folder ? path : dirname(path);
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
