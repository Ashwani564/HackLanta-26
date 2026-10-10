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
