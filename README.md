# HackLanta '26: iMessage dining agent

Your friend who checks the menu before you do. Text it a menu or food photo, ask what to eat, or start a group poll, all inside iMessage.

| Folder | What it is |
|---|---|
| [`bot/`](bot/) | iMessage bot server (Node/TypeScript, Photon Spectrum, Gemini). Setup and run instructions are in [`bot/README.md`](bot/README.md). |

## Quick start

```bash
cd bot
npm install
cp .env.example .env   # add Photon + Gemini keys
npm run dev
```

Secrets live only in `bot/.env`, which is git-ignored. Never commit real keys.

## Saving AI tokens with graphify

This repo ships a [graphify](https://github.com/safishamsi/graphify) code map (`graphify-out/graph.json` + `GRAPH_REPORT.md`) so Claude Code can query the codebase structure instead of re-reading files. One-time setup per teammate:

```bash
uv tool install graphifyy    # installs the `graphify` CLI
graphify hook install        # git hooks: rebuild the map after each commit/checkout (local only)
```

- Claude Code picks it up automatically via `.claude/settings.json` and the `CLAUDE.md` rules (the hook is skipped if graphify isn't installed).
- Ask questions with `graphify query "how does X work"`, `graphify explain "annotateFood"`, `graphify path "handle" "sendDayCard"`.
- After code changes: `graphify update .` (local AST parsing, no API key or cost). Commit the refreshed `graph.json`/`GRAPH_REPORT.md` with `git add -f`.
