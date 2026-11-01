import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

function readSettings(path) {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new Error(`${path} is not valid JSON. Fix that file, then run this command again.`);
  }
}

function writeWithBackup(path, settings) {
  let backupPath = null;
  if (existsSync(path)) {
    backupPath = `${path}.product-stats-backup`;
    copyFileSync(path, backupPath);
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`);
  return backupPath;
}

const hasCommand = (group, command) => group.hooks?.some((h) => h.command === command);

export function addHook(settingsPath, command) {
  const settings = readSettings(settingsPath);
  const groups = settings.hooks?.SessionEnd ?? [];
  if (groups.some((g) => hasCommand(g, command))) return { changed: false, backupPath: null };
  settings.hooks = {
    ...settings.hooks,
    SessionEnd: [...groups, { hooks: [{ type: 'command', command }] }],
  };
  return { changed: true, backupPath: writeWithBackup(settingsPath, settings) };
}

export function removeHook(settingsPath, command) {
  const settings = readSettings(settingsPath);
  const groups = settings.hooks?.SessionEnd ?? [];
  if (!groups.some((g) => hasCommand(g, command))) return { changed: false };
  settings.hooks.SessionEnd = groups.filter((g) => !hasCommand(g, command));
  if (!settings.hooks.SessionEnd.length) delete settings.hooks.SessionEnd;
  writeWithBackup(settingsPath, settings);
  return { changed: true };
}

export function hookCommand(stateDir, nodePath) {
  return `"${nodePath}" "${join(stateDir, 'app', 'bin', 'product-stats.js')}" sync --quiet`;
}

export function copyApp(appDir, stateDir) {
  for (const name of ['bin', 'src', 'public', 'package.json']) {
    cpSync(join(appDir, name), join(stateDir, 'app', name), { recursive: true });
  }
}

export async function ensureConnected({ stateDir, settingsPath, appDir, nodePath, ask }) {
  const choicePath = join(stateDir, 'settings.json');
  const saved = existsSync(choicePath) ? JSON.parse(readFileSync(choicePath, 'utf8')) : null;
  if (saved) {
    if (saved.connected) copyApp(appDir, stateDir);
    return { connected: saved.connected };
  }
  if (!ask) return { connected: false };

  const connected = await ask();
  if (connected) {
    copyApp(appDir, stateDir);
    addHook(settingsPath, hookCommand(stateDir, nodePath));
  }
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(choicePath, JSON.stringify({ connected }));
  return { connected };
}
