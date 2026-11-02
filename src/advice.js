// Advice comes from numbers only. The tool cannot see what a person asked for,
// so every saving is an estimate.
export const LONG_CHAT_STEPS = 300;
const SMALL_STEP_TOKENS = 1000;
const LARGE_MODEL = /opus/i;
const MANY_MESSAGES = 40;
const FEW_STEPS_PER_MESSAGE = 2;
const MANY_STOPS = 3;
const REPEAT_SESSIONS = 5;
const WEEKS = 8;

const compact = (n) => (n >= 1e9 ? `${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : String(Math.round(n)));

function totals(facts) {
  const days = Object.values(facts.byDay);
  return {
    steps: days.reduce((a, d) => a + d.requests, 0),
    newTokens: days.reduce((a, d) => a + d.newTokens, 0),
    rereadTokens: days.reduce((a, d) => a + d.rereadTokens, 0),
  };
}

// One session holds the main chat and one chat for each subagent.
function chatsOf(facts) {
  const chats = new Map();
  for (const r of Object.values(facts.requests ?? {}).sort((a, b) => a[0] - b[0])) {
    const key = r[4] ?? 0;
    chats.set(key, [...(chats.get(key) ?? []), r[3]]);
  }
  return [...chats.values()];
}

/* Replay a chat step by step, as if a new chat started every LONG_CHAT_STEPS steps.
   A new chat keeps the small context of the first steps and drops what built up since
   the last restart. This is a simulation, because a real new chat also needs catching up. */
function replayChat(rereads, every) {
  if (rereads.length <= every) return 0;
  const first = rereads.slice(0, 10);
  const base = first.reduce((a, b) => a + b, 0) / first.length;
  let saved = 0;
  rereads.forEach((value, i) => {
    if (i < every) return;
    const restart = rereads[i - (i % every)];
    saved += value - Math.max(base, value - restart + base);
  });
  return Math.max(0, saved);
}

export function replaySaving(facts, every = LONG_CHAT_STEPS) {
  return chatsOf(facts).reduce((a, chat) => a + replayChat(chat, every), 0);
}

export function sessionAdvice(facts) {
  const { steps, newTokens, rereadTokens } = totals(facts);
  const chatSteps = Math.max(0, ...chatsOf(facts).map((c) => c.length));
  const path = facts.path ?? {};
  const tips = [];
  let saved = 0;
  if (chatSteps > LONG_CHAT_STEPS) {
    const save = replaySaving(facts);
    saved += save;
    if (save > 0) tips.push({ kind: 'long-chat', tested: true, save, text: `This chat got very long, with ${chatSteps} steps. The AI reread about ${compact(rereadTokens / steps)} tokens of old chat at every step. Starting a fresh chat every ${LONG_CHAT_STEPS} steps could have cut up to ${compact(save)} re-read tokens.` });
  }
  const messages = path.messages ?? 0;
  const actions = path.actions ?? 0;
  if (messages >= MANY_MESSAGES && actions / messages < FEW_STEPS_PER_MESSAGE) {
    tips.push({ kind: 'short-messages', tested: false, save: 0, text: `Try this: you sent ${messages} short messages. Put related requests together in one message.` });
  }
  const [model] = Object.entries(facts.byModel).sort((a, b) => b[1].newTokens - a[1].newTokens)[0] ?? [];
  if (model && LARGE_MODEL.test(model) && steps >= 100 && newTokens / steps < SMALL_STEP_TOKENS) {
    tips.push({ kind: 'large-model', tested: false, save: 0, text: `Try this: most of the work was small, but it used ${model}, a big model. A smaller model can do small jobs.` });
  }
  if ((path.stops ?? 0) >= MANY_STOPS) {
    tips.push({ kind: 'stops', tested: false, save: 0, text: `Try this: you stopped the AI ${path.stops} times. Say exactly what you want in your first message.` });
  }
  return { steps, chatSteps, newTokens, rereadTokens, saved, tips };
}

function repeatedFiles(sessions) {
  const seen = new Map();
  for (const s of sessions) {
    for (const key of new Set(Object.values(s.fileKeys ?? {}).flat())) seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  return [...seen.values()].filter((n) => n >= REPEAT_SESSIONS).length;
}

function weekOf(ms) {
  const d = new Date(ms);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); // Monday
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function byWeek(rows, size) {
  const weeks = new Map();
  for (const r of rows) {
    const key = weekOf(r.at);
    const w = weeks.get(key) ?? { week: key, sessions: 0, steps: 0, newTokens: 0, rereadTokens: 0, saved: 0, longChats: 0 };
    w.sessions += 1;
    w.steps += r.steps;
    w.newTokens += r.newTokens;
    w.rereadTokens += r.rereadTokens;
    w.saved += r.saved;
    w.longChats += r.chatSteps > LONG_CHAT_STEPS ? 1 : 0;
    weeks.set(key, w);
  }
  return [...weeks.values()].sort((a, b) => a.week.localeCompare(b.week)).slice(-size);
}

export function buildAdvice(sessions, describe, { limit = 5, weeks = WEEKS, keepAll = false } = {}) {
  const rows = sessions
    .map((s) => ({ ...sessionAdvice(s), at: s.lastAt, ...describe(s) }))
    .filter((r) => r.steps > 0)
    .sort((a, b) => b.at - a.at);
  const latest = rows[0] ?? null;
  const worst = rows.filter((r) => r.saved > 0).sort((a, b) => b.saved - a.saved).slice(0, limit);
  const rereadTokens = rows.reduce((a, r) => a + r.rereadTokens, 0);
  const longChats = rows.filter((r) => r.chatSteps > LONG_CHAT_STEPS);
  return {
    saved: rows.reduce((a, r) => a + r.saved, 0),
    rereadTokens,
    longChats: longChats.length,
    longChatShare: rereadTokens ? longChats.reduce((a, r) => a + r.rereadTokens, 0) / rereadTokens : 0,
    repeatedFiles: repeatedFiles(sessions),
    repeatSessions: REPEAT_SESSIONS,
    longChatSteps: LONG_CHAT_STEPS,
    count: rows.length,
    weeks: byWeek(rows, weeks),
    latest,
    worst,
    ...(keepAll ? { all: rows } : {}),
  };
}
