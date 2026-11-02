# Token Tally

A live dashboard for people who build with Claude Code and Codex. It shows what each product took to make, and where the tokens went.

Everything runs on your own computer. The tool has no accounts, and it sends nothing to any server.

## Start

You need Node.js 20 or later.

```
npx github:manyatamanocha/Token-Tally
```

The first run asks if the tool can connect to Claude Code. A yes adds one `SessionEnd` hook to your Claude Code settings and makes a backup of that file. Numbers then save when the dashboard is closed. A no is also fine: the dashboard works, but it can miss logs that Claude Code deletes while the dashboard is closed.

Use the same command to open the dashboard later. Keep the terminal window open for live numbers.

## Save tokens

The Save tokens section looks at each session and gives advice, such as starting a new chat sooner. Savings are estimates from numbers only. The tool cannot read your chats, so it cannot know if a task needed the extra steps. It assumes that a chat split at 300 steps keeps about 300/N of its re-read tokens.

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
npx github:manyatamanocha/Token-Tally uninstall
```

This removes the hook. Delete `~/.token-tally` to remove your numbers too.
