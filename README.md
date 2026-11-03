# Token Tally

A live dashboard for people who build with Claude Code and Codex. It shows what each product took to make, and where the tokens went.

Everything runs on your own computer. The tool has no accounts, and it sends nothing to any server.

## Start

You need Node.js 20 or later.

```
npx @manyatamanocha/token-tally
```

The first run asks if the tool can connect to Claude Code. A yes adds one `SessionEnd` hook to your Claude Code settings and makes a backup of that file. Numbers then save when the dashboard is closed. A no is also fine: the dashboard works, but it can miss logs that Claude Code deletes while the dashboard is closed.

Use the same command to open the dashboard later. Keep the terminal window open for live numbers.

## Save tokens

A "Your Token Advice" bar under the top numbers shows one line about your last chat. Click it to open the advice page.

- **Tested:** "Start a new chat more often." The saving comes from replaying each long chat as if a new chat started every 300 steps. It is an estimate, it counts tokens and not money, and a real new chat also needs some catching up.
- **Each chat counts alone:** A subagent is its own chat, so it is replayed apart from the main chat.
- **Ideas:** The other tips are ideas to try. They have not been tested, so they show no saving.

The tool cannot read your chats, so it cannot know if a task needed the extra steps.

## What each number means

| Number | Meaning |
|---|---|
| Days | Days with work on this product only |
| Estimated hours | Time between messages. A gap of more than 15 minutes does not count. |
| Agents | Sessions you started that touched this product |
| Subagents | Helpers that those sessions started |
| New tokens | New input, AI output and text saved to cache for the first time |
| Re-read tokens | Cache reads: saved text that the AI reads again |
| Re-read tokens per request | Re-read tokens divided by AI requests. A high number means that sessions run long. |

## How products are found

The tool looks at the files that each session changed. A file belongs to the nearest folder with a git repository. If there is none, it belongs to the first folder under your home folder that is not a general folder such as Documents or an Obsidian vault.

You can rename a product, join two products, hide a product, and assign a session in "Not sorted yet" to a product. You can undo a join or an assignment at the bottom of the page.

## Limits

- Hours are estimates.
- If a session touches more than one product, its tokens and hours split by the number of files changed. This is an estimate of effort.
- Days, agents and subagents count in full for each product that a session touched. So product totals for these can add up to more than your real total.
- The tool cannot see files changed through shell commands. Those sessions use the files they read, then the working folder, then "Not sorted yet".
- Claude Code and Codex are supported. Compressed Codex logs need Node 22.15 or newer.

## What it stores

The tool stores numbers, dates, model names, request IDs, session IDs and product folder paths in `~/.token-tally/record.json`. It never stores chat text.

## Remove it

```
npx @manyatamanocha/token-tally uninstall
```

This removes the hook. Delete `~/.token-tally` to remove your numbers too.
