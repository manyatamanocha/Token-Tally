import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { addHook, removeHook, ensureConnected } from '../src/hook.js';

const CMD = '"/new/node" "/h/.product-stats/app/bin/product-stats.js" sync --quiet';
const OLD = '"/old/node" "/h/.product-stats/app/bin/product-stats.js" sync --quiet';
const BIN = fileURLToPath(new URL('../bin/product-stats.js', import.meta.url));
const APP = fileURLToPath(new URL('..', import.meta.url));
let dir, settings;
const read = () => JSON.parse(readFileSync(settings, 'utf8'));
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ps-hook-'));
  settings = join(dir, 'settings.json');
});

test('adds a SessionEnd command hook', () => {
  addHook(settings, CMD);
  assert.deepEqual(read().hooks.SessionEnd, [{ hooks: [{ type: 'command', command: CMD }] }]);
});
test('keeps all existing hooks and settings', () => {
  const other = { hooks: [{ type: 'command', command: 'other' }] };
  writeFileSync(settings, JSON.stringify({ theme: 'dark', hooks: { Stop: [other], SessionEnd: [other] } }));
  addHook(settings, CMD);
  const s = read();
  assert.equal(s.theme, 'dark');
  assert.deepEqual(s.hooks.Stop, [other]);
  assert.deepEqual(s.hooks.SessionEnd[0], other);
  assert.equal(s.hooks.SessionEnd.length, 2);
});
test('makes a backup before a change', () => {
  writeFileSync(settings, '{"theme":"dark"}');
  const { backupPath } = addHook(settings, CMD);
  assert.equal(readFileSync(backupPath, 'utf8'), '{"theme":"dark"}');
});
test('a second add changes nothing', () => {
  addHook(settings, CMD);
  assert.equal(addHook(settings, CMD).changed, false);
  assert.equal(read().hooks.SessionEnd.length, 1);
});
test('invalid JSON throws and leaves the file unchanged', () => {
  writeFileSync(settings, '{broken');
  assert.throws(() => addHook(settings, CMD), /not valid JSON/);
  assert.equal(readFileSync(settings, 'utf8'), '{broken');
  assert.deepEqual(readdirSync(dir), ['settings.json']);
});
test('a missing settings file is created', () => {
  assert.equal(addHook(settings, CMD).changed, true);
  assert.ok(existsSync(settings));
});
test('remove deletes only this hook', () => {
  const other = { hooks: [{ type: 'command', command: 'other' }] };
  writeFileSync(settings, JSON.stringify({ hooks: { SessionEnd: [other] } }));
  addHook(settings, CMD);
  assert.equal(removeHook(settings).changed, true);
  assert.deepEqual(read().hooks.SessionEnd, [other]);
});
test('add replaces a stale Node path', () => {
  addHook(settings, OLD);
  assert.equal(addHook(settings, CMD).changed, true);
  assert.deepEqual(read().hooks.SessionEnd, [{ hooks: [{ type: 'command', command: CMD }] }]);
});
test('remove finds a hook with an old Node path', () => {
  addHook(settings, OLD);
  assert.equal(removeHook(settings).changed, true);
  assert.equal(read().hooks.SessionEnd, undefined);
});
test('remove keeps another hook in the same group', () => {
  const other = { type: 'command', command: 'other' };
  writeFileSync(settings, JSON.stringify({ hooks: { SessionEnd: [{ hooks: [other, { type: 'command', command: CMD }] }] } }));
  removeHook(settings);
  assert.deepEqual(read().hooks.SessionEnd, [{ hooks: [other] }]);
});
test('a later run repairs a stale Node path', async () => {
  const stateDir = join(dir, '.product-stats');
  await ensureConnected({ stateDir, settingsPath: settings, appDir: APP, nodePath: '/old/node', ask: async () => true });
  await ensureConnected({ stateDir, settingsPath: settings, appDir: APP, nodePath: '/new/node', ask: null });
  assert.match(read().hooks.SessionEnd[0].hooks[0].command, /^"\/new\/node"/);
});
test('uninstall removes the hook and the saved choice', () => {
  const home = join(dir, 'home3');
  mkdirSync(join(home, '.claude'), { recursive: true });
  mkdirSync(join(home, '.product-stats'));
  writeFileSync(join(home, '.product-stats', 'settings.json'), '{"connected":true}');
  addHook(join(home, '.claude', 'settings.json'), OLD);
  const run = spawnSync(process.execPath, [BIN, 'uninstall'], { env: { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: '' }, encoding: 'utf8' });
  assert.equal(run.status, 0);
  assert.match(run.stdout, /Disconnected/);
  assert.equal(existsSync(join(home, '.product-stats', 'settings.json')), false);
});
test('uninstall with invalid settings prints a clear message', () => {
  const home = join(dir, 'home4');
  mkdirSync(join(home, '.claude'), { recursive: true });
  writeFileSync(join(home, '.claude', 'settings.json'), '{broken');
  const run = spawnSync(process.execPath, [BIN, 'uninstall'], { env: { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: '' }, encoding: 'utf8' });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /not valid JSON/);
  assert.doesNotMatch(run.stderr, /at .*hook\.js/);
});
test('a yes copies the app and connects', async () => {
  const stateDir = join(dir, 'state');
  const result = await ensureConnected({ stateDir, settingsPath: settings, appDir: APP, nodePath: 'node', ask: async () => true });
  assert.equal(result.connected, true);
  assert.ok(existsSync(join(stateDir, 'app', 'package.json')));
  assert.ok(existsSync(join(stateDir, 'app', 'src', 'server.js')));
  assert.match(read().hooks.SessionEnd[0].hooks[0].command, /sync --quiet/);
});
test('a no leaves settings alone and asks one time', async () => {
  const stateDir = join(dir, 'state');
  let asks = 0;
  const ask = async () => { asks += 1; return false; };
  await ensureConnected({ stateDir, settingsPath: settings, appDir: APP, nodePath: 'node', ask });
  await ensureConnected({ stateDir, settingsPath: settings, appDir: APP, nodePath: 'node', ask });
  assert.equal(asks, 1);
  assert.equal(existsSync(settings), false);
});
test('with no terminal it does not connect and asks again later', async () => {
  const stateDir = join(dir, 'state');
  const first = await ensureConnected({ stateDir, settingsPath: settings, appDir: APP, nodePath: 'node', ask: null });
  assert.equal(first.connected, false);
  let asks = 0;
  await ensureConnected({ stateDir, settingsPath: settings, appDir: APP, nodePath: 'node', ask: async () => { asks += 1; return false; } });
  assert.equal(asks, 1);
});
test('sync --quiet prints nothing and exits 0', () => {
  const home = join(dir, 'home');
  mkdirSync(home);
  const run = spawnSync(process.execPath, [BIN, 'sync', '--quiet'], { env: { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: '' }, encoding: 'utf8' });
  assert.equal(run.status, 0);
  assert.equal(run.stdout + run.stderr, '');
});
test('sync --quiet exits 0 when the state folder cannot be used', () => {
  const home = join(dir, 'home2');
  mkdirSync(home);
  writeFileSync(join(home, '.product-stats'), 'a file, not a folder');
  mkdirSync(join(home, '.claude', 'projects', 'p'), { recursive: true });
  writeFileSync(join(home, '.claude', 'projects', 'p', 's.jsonl'), '{}\n');
  const run = spawnSync(process.execPath, [BIN, 'sync', '--quiet'], { env: { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: '' }, encoding: 'utf8' });
  assert.equal(run.status, 0);
  assert.equal(run.stdout + run.stderr, '');
});
test('an unknown command explains the choices and exits 1', () => {
  const run = spawnSync(process.execPath, [BIN, 'nonsense'], { encoding: 'utf8' });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /Commands:/);
});
