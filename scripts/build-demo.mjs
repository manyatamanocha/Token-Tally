// Builds the public demo site in docs/. All products and numbers are made up.
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildDashboard } from '../src/aggregate.js';
import { newRecord } from '../src/record.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const out = `${root}docs`;
const END = Date.parse('2026-11-03T18:00:00Z');
const DAY = 86400000;
const PRODUCTS = [['Recipe Finder', 5], ['Budget Buddy', 4], ['Travel Planner', 3], ['Habit Tracker', 2], ['Study Notes', 2], ['Plant Care', 1]];
const MODELS = { claude: ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-haiku-5-5'], codex: ['gpt-6-astra', 'gpt-6-luna'] };

let seed = 7;
const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
const pick = (list) => list[Math.floor(rand() * list.length)];
const weighted = () => {
  const total = PRODUCTS.reduce((a, [, w]) => a + w, 0);
  let r = rand() * total;
  for (const [name, w] of PRODUCTS) if ((r -= w) < 0) return name;
  return PRODUCTS[0][0];
};
const day = (ms) => new Date(ms).toISOString().slice(0, 10);

function session(n) {
  const llm = rand() < 0.8 ? 'claude' : 'codex';
  const product = rand() < 0.1 ? null : weighted();
  const steps = Math.round(rand() < 0.15 ? 320 + rand() * 450 : 20 + rand() * 230);
  const start = END - Math.floor(rand() * 27 * DAY) - steps * 40000;
  const growth = 300 + rand() * 900;
  const subagents = llm === 'claude' && rand() < 0.2 ? 1 + Math.floor(rand() * 3) : 0;
  const requests = {};
  const byDay = {};
  const byModel = {};
  let time = start;
  for (let i = 0; i < steps; i += 1) {
    time += 20000 + Math.floor(rand() * 40000);
    const agent = subagents && i % 7 === 6 ? 1 + (i % subagents) : 0;
    const model = i % 5 === 0 ? MODELS[llm][1] : MODELS[llm][0];
    const newTokens = 1500 + Math.floor(rand() * 7000);
    const reread = Math.floor(18000 + (agent ? 200 : i) * growth);
    requests[`demo-${n}-${i}`] = agent ? [time, model, newTokens, reread, agent] : [time, model, newTokens, reread];
    const d = (byDay[day(time)] ??= { newTokens: 0, rereadTokens: 0, requests: 0 });
    d.newTokens += newTokens; d.rereadTokens += reread; d.requests += 1;
    const m = (byModel[model] ??= { newTokens: 0, rereadTokens: 0 });
    m.newTokens += newTokens; m.rereadTokens += reread;
  }
  const actions = steps;
  const rootId = product ? `/demo/${product}` : null;
  const files = Math.max(1, Math.round(steps / 12));
  return {
    sessionId: `demo-${n}`, llm, startedAt: start, lastAt: time, spans: [[start, time]], byDay, byModel, requests, subagents,
    written: rootId ? { [rootId]: files } : {}, read: {}, cwdRoot: null,
    fileKeys: rootId ? { [rootId]: Array.from({ length: files }, (_, i) => `${product}-${i % 9}-${n % 3}`) } : {},
    path: { messages: Math.max(1, Math.round(steps / (3 + rand() * 3))), stops: rand() < 0.3 ? 1 + Math.floor(rand() * 3) : 0, actions, reads: Math.round(actions * 0.2), edits: Math.round(actions * 0.1), commands: Math.round(actions * 0.5), web: Math.round(actions * 0.05), other: Math.round(actions * 0.12), delegated: subagents },
  };
}

const record = newRecord();
for (let n = 0; n < 64; n += 1) { const s = session(n); record.sessions[s.sessionId] = s; }
const data = {
  ...buildDashboard(record, END),
  views: { claude: buildDashboard(record, END, 'claude'), codex: buildDashboard(record, END, 'codex') },
  syncing: false, notice: null, skippedLogs: 0,
};
const configPath = `${root}scripts/site-config.json`;
const signup = existsSync(configPath) ? JSON.parse(readFileSync(configPath, 'utf8')) : null;
const page = readFileSync(`${root}public/index.html`, 'utf8').replace('<script>\n', `<script>window.TT_DEMO = true; window.TT_SIGNUP = ${JSON.stringify(signup)};</script>\n<script>\n`);
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
writeFileSync(`${out}/index.html`, page.replace('<title>Token Tally</title>', '<title>Token Tally demo</title>'));
writeFileSync(`${out}/data.json`, JSON.stringify(data));
writeFileSync(`${out}/.nojekyll`, '');
console.log(`demo: ${data.products.length} products, ${data.sessionCount} sessions, ${signup ? 'sign-up on' : 'sign-up off'}`);
