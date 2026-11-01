import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findRoot } from '../src/roots.js';

const home = '/h';
const present = new Set([
  '/h/Documents/Vault/App/hamsty/.git',
  '/h/Documents/Vault/.obsidian',
  '/h/site/.git',
]);
const opts = { home, exists: (p) => present.has(p) };

test('nearest parent with .git is the root', () => {
  assert.equal(findRoot('/h/Documents/Vault/App/hamsty/src/a.js', opts), '/h/Documents/Vault/App/hamsty');
});
test('skips container folders without git', () => {
  assert.equal(findRoot('/h/Documents/Vault/Voucher App/a.md', opts), '/h/Documents/Vault/Voucher App');
});
test('a folder directly under home is a root', () => {
  assert.equal(findRoot('/h/recipes/a.md', opts), '/h/recipes');
});
test('a folder path resolves to itself', () => {
  assert.equal(findRoot('/h/recipes', { ...opts, folder: true }), '/h/recipes');
});
test('a folder with a dot in its name is a root', () => {
  assert.equal(findRoot('/h/code/my.app', { ...opts, folder: true }), '/h/code/my.app');
});
test('dotfiles and dot folders are not products', () => {
  for (const p of ['/h/.zshrc', '/h/.ssh/config', '/h/.config/app/x.json', '/h/.ship-tally/record.json']) {
    assert.equal(findRoot(p, opts), null);
  }
});
test('a file with no extension in a container is not a product', () => {
  assert.equal(findRoot('/h/Documents/Vault/Makefile', opts), null);
});
test('a file with no extension in a project stays in that project', () => {
  assert.equal(findRoot('/h/recipes/Makefile', opts), '/h/recipes');
});
test('ignores ~/.claude files', () => assert.equal(findRoot('/h/.claude/memory/a.md', opts), null));
test('ignores temp and Library paths', () => {
  for (const p of ['/tmp/a.js', '/private/tmp/a.js', '/private/var/a.js', '/h/Library/a.js']) {
    assert.equal(findRoot(p, opts), null);
  }
});
test('a loose file directly in home is null', () => assert.equal(findRoot('/h/notes.txt', opts), null));
test('the home folder itself is null', () => assert.equal(findRoot('/h', { ...opts, folder: true }), null));
test('a loose file in a container is null', () => {
  assert.equal(findRoot('/h/Documents/notes.txt', opts), null);
});
test('a path outside home with no git is null', () => assert.equal(findRoot('/opt/x/a.js', opts), null));
test('a git repo outside home is a root', () => {
  assert.equal(findRoot('/opt/x/a.js', { home, exists: (p) => p === '/opt/x/.git' }), '/opt/x');
});
