#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { ensureConnected, removeHook } from '../src/hook.js';
import { ingest } from '../src/ingest.js';
import { loadRecord, saveRecord } from '../src/record.js';
import { startServer } from '../src/server.js';

const home = homedir();
const claudeDir = process.env.CLAUDE_CONFIG_DIR || join(home, '.claude');
const projectsDir = join(claudeDir, 'projects');
const codexDir = join(process.env.CODEX_HOME || join(home, '.codex'), 'sessions');
const settingsPath = join(claudeDir, 'settings.json');
const stateDir = join(home, '.ship-tally');
const recordPath = join(stateDir, 'record.json');
const appDir = fileURLToPath(new URL('..', import.meta.url));

async function sync() {
  const record = loadRecord(recordPath);
  const { changed } = await ingest({ projectsDir, codexDir, record, home });
  if (changed) saveRecord(recordPath, record);
}

async function askToConnect() {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question('Connect to Claude Code so that numbers save when the dashboard is closed? (y/n) ');
  rl.close();
  return /^y/i.test(answer.trim());
}

function openBrowser(url) {
  const command = { darwin: 'open', win32: 'cmd' }[process.platform] ?? 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  const child = spawn(command, args, { stdio: 'ignore', detached: true });
  child.on('error', () => {});
  child.unref();
}

async function open() {
  try {
    await ensureConnected({
      stateDir, settingsPath, appDir, nodePath: process.execPath,
      ask: process.stdin.isTTY ? askToConnect : null,
    });
  } catch (error) {
    console.error(error.message);
    console.error('The dashboard still opens, but numbers save only while it is open.');
  }
  const app = await startServer({ recordPath, projectsDir, codexDir, home });
  openBrowser(app.url);
  if (app.alreadyRunning) {
    console.log(`The dashboard is already running at ${app.url}`);
    return;
  }
  console.log(`Dashboard: ${app.url}`);
  console.log('Keep this window open for live numbers. Press Control-C to stop.');
}

function uninstall() {
  const { changed } = removeHook(settingsPath);
  rmSync(join(stateDir, 'settings.json'), { force: true });
  console.log(changed ? 'Disconnected from Claude Code.' : 'The tool was not connected to Claude Code.');
  console.log(`Your numbers are still in ${stateDir}. Delete that folder to remove them.`);
}

const [command, flag] = process.argv.slice(2);
if (command === 'sync') {
  try {
    await sync();
  } catch (error) {
    if (flag !== '--quiet') console.error(error.message);
  }
  process.exit(0);
} else if (command === 'uninstall') {
  try {
    uninstall();
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
} else if (!command) {
  try {
    await open();
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
} else {
  console.error('Commands: no command opens the dashboard. Others: sync, uninstall.');
  process.exit(1);
}
