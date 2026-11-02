// Advice comes from numbers only. The tool cannot see what a person asked for,
// so every saving is an estimate.
export const LONG_CHAT_STEPS = 300;
const SMALL_STEP_TOKENS = 1000;
const LARGE_MODEL = /opus/i;
const MANY_MESSAGES = 40;
const FEW_STEPS_PER_MESSAGE = 2;
const MANY_STOPS = 3;
const REPEAT_SESSIONS = 5;

const compact = (n) => (n >= 1e9 ? `${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : String(Math.round(n)));

function totals(facts) {
  const days = Object.values(facts.byDay);
  return {
    steps: days.reduce((a, d) => a + d.requests, 0),
    newTokens: days.reduce((a, d) => a + d.newTokens, 0),
    rereadTokens: days.reduce((a, d) => a + d.rereadTokens, 0),
  };
}

/* Replay a chat step by step, as if a new chat started every LONG_CHAT_STEPS steps.
   A new chat keeps the small context of the first steps and drops what built up since
   the last restart. This is a simulation, because a real new chat also needs catching up. */
export function replaySaving(facts, every = LONG_CHAT_STEPS) {
  const rereads = Object.values(facts.requests ?? {}).sort((a, b) => a[0] - b[0]).map((r) => r[3]);
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

export function sessionAdvice(facts) {
  const { steps, newTokens, rereadTokens } = totals(facts);
  const path = facts.path ?? {};
  const tips = [];
  let saved = 0;
  if (steps > LONG_CHAT_STEPS) {
    const save = replaySaving(facts);
    saved += save;
    if (save > 0) tips.push({ kind: 'long-chat', tested: true, save, text: `This chat got very long, with ${steps} steps. The AI reread about ${compact(rereadTokens / steps)} tokens of old chat at every step. Starting a fresh chat every ${LONG_CHAT_STEPS} steps could have saved about ${compact(save)} tokens.` });
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
  return { steps, newTokens, rereadTokens, saved, tips };
}

function repeatedFiles(sessions) {
  const seen = new Map();
  for (const s of sessions) {
    for (const key of new Set(Object.values(s.fileKeys ?? {}).flat())) seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  return [...seen.values()].filter((n) => n >= REPEAT_SESSIONS).length;
}

export function buildAdvice(sessions, describe, limit = 5) {
  const rows = sessions
    .map((s) => ({ ...sessionAdvice(s), at: s.lastAt, ...describe(s) }))
    .filter((r) => r.steps > 0);
  const latest = [...rows].sort((a, b) => b.at - a.at)[0] ?? null;
  const worst = rows.filter((r) => r.saved > 0).sort((a, b) => b.saved - a.saved).slice(0, limit);
  const rereadTokens = rows.reduce((a, r) => a + r.rereadTokens, 0);
  const longChats = rows.filter((r) => r.steps > LONG_CHAT_STEPS);
  return {
    saved: rows.reduce((a, r) => a + r.saved, 0),
    rereadTokens,
    longChats: longChats.length,
    longChatShare: rereadTokens ? longChats.reduce((a, r) => a + r.rereadTokens, 0) / rereadTokens : 0,
    repeatedFiles: repeatedFiles(sessions),
    repeatSessions: REPEAT_SESSIONS,
    longChatSteps: LONG_CHAT_STEPS,
    latest,
    worst,
  };
}
