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

/* Re-read tokens grow with chat length, so splitting one chat of N steps into chats
   of C steps keeps about C/N of them. */
export function sessionAdvice(facts) {
  const { steps, newTokens, rereadTokens } = totals(facts);
  const path = facts.path ?? {};
  const tips = [];
  let saved = 0;
  if (steps > LONG_CHAT_STEPS) {
    const save = rereadTokens * (1 - LONG_CHAT_STEPS / steps);
    saved += save;
    tips.push({ kind: 'long-chat', save, text: `This chat ran ${steps} steps and re-read about ${compact(rereadTokens / steps)} tokens on each step. A new chat every ${LONG_CHAT_STEPS} steps could have saved about ${compact(save)} tokens.` });
  }
  const messages = path.messages ?? 0;
  const actions = path.actions ?? 0;
  if (messages >= MANY_MESSAGES && actions / messages < FEW_STEPS_PER_MESSAGE) {
    const save = (messages / 2) * (rereadTokens / (steps || 1));
    saved += steps > LONG_CHAT_STEPS ? 0 : save;
    tips.push({ kind: 'short-messages', save, text: `You sent ${messages} messages, and agents took few steps for each one. Each message re-reads the chat, so putting several requests into one message could have saved about ${compact(save)} tokens.` });
  }
  const [model] = Object.entries(facts.byModel).sort((a, b) => b[1].newTokens - a[1].newTokens)[0] ?? [];
  if (model && LARGE_MODEL.test(model) && steps >= 100 && newTokens / steps < SMALL_STEP_TOKENS) {
    tips.push({ kind: 'large-model', save: 0, text: `Most steps were small, but they used ${model}, a large model. A smaller model can often do small steps at a lower cost.` });
  }
  if ((path.stops ?? 0) >= MANY_STOPS) {
    tips.push({ kind: 'stops', save: 0, text: `You stopped agents ${path.stops} times. Work before a stop is often repeated, so a clearer first message can help.` });
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
