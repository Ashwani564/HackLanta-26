# iMessage dining agent (bot)

An iMessage bot that helps you decide what to eat. It runs on [Photon Spectrum](https://photon.codes/docs/spectrum-ts/introduction) for iMessage and Gemini for the AI.

## What it can do

| Text the bot | What happens |
|---|---|
| Any message | Gemini replies in one short line, with diet, allergy, calorie and budget awareness. |
| A food photo | Estimated calories and protein for the dish. |
| A menu photo | Best 1-2 picks, with calorie estimates. |
| "make a poll for where to eat" | Sends a native iMessage poll. Votes are logged. |
| "send me a voice note …" / a voice message | Replies with a spoken voice note (Gemini TTS). |
| "where am I?" / "food near me" | Sends a Find My request card, then reads the shared location. |
| `/reset` | Clears that chat's memory. |

## Requirements

- **macOS.** Voice notes use the built-in `afconvert` tool.
- **Node.js 20.6+** (`node --version`).
- A **Photon** project ([app.photon.codes](https://app.photon.codes)) with iMessage enabled.
- A **Gemini API key** ([aistudio.google.com/apikey](https://aistudio.google.com/apikey)).

## Setup

```bash
cd bot
npm install
cp .env.example .env    # then fill in the three keys
```

Then register who can text the bot. On Photon's Free and Pro plans, the bot can only talk to numbers added as **users**:
Dashboard → your project → **Users** → add your iMessage phone number. Each user gets
their own bot number (`assignedPhoneNumber`). Text that number.

Not sure which handle your iMessage sends from? Text [debug.photon.codes](https://debug.photon.codes).

## Run

```bash
npm run dev        # live iMessage, auto-restarts on file changes
npm start          # live iMessage, no auto-restart
npm run terminal   # local chat UI in your terminal, no Photon credentials needed
npm run typecheck
```

Send a one-off message from the bot to a registered user:

```bash
npm run send -- +15551234567 "Dinner poll in 5 min!"
```

No public URL or ngrok is needed. The server connects out to Photon over gRPC.

## Project layout

```
bot/
├── src/
│   ├── index.ts     # Spectrum app: receives messages and routes by type (text/photo/voice/poll vote)
│   ├── gemini.ts    # System prompt, tool definitions, tool-call loop, per-chat memory, model fallback
│   ├── voice.ts     # Gemini TTS -> .m4a voice note; inbound voice -> WAV for Gemini
│   └── findmy.ts    # Find My location via @photon-ai/advanced-imessage
├── scripts/
│   └── send.ts      # CLI: send a message to a user
└── .env.example     # Copy to .env (never commit .env)
```

## How it works

- **Messages:** `index.ts` reads the `app.messages` stream and handles each message concurrently, so one slow reply doesn't block others.
- **Gemini tools:** Gemini decides when to call `create_poll`, `send_voice_note` or `get_location`. `index.ts` carries them out.
- **Models:** `gemini-2.5-flash` with thinking off, for about 0.5 s replies. If it returns 503/429, the bot falls back to `gemini-3.1-flash-lite`. Avoid `gemini-flash-latest`: it now points to a thinking model that takes 30-45 s.
- **Find My:** Spectrum doesn't expose locations, so `findmy.ts` opens its own client to `imessage.spectrum.photon.codes:443` with a token from `POST /projects/{id}/imessage/tokens`. It works on the free shared plan.

## Known limits

- **Group chats:** Free and Pro plans use shared numbers, which can't create groups or receive group events. Polls work in any chat. Group workflows need the Business plan, which gives one dedicated number.
- **Quotas:** 5,000 messages per server per day, and 50 new conversations per line per day.
- **Memory:** chat history is in memory and is lost on restart.
- **Nutrition numbers** are Gemini estimates, not verified data.
- **Live app cards** (`app(url, { live: true })`) need recipients to install the "Spectrum by Photon" iMessage app once.

## Docs

- Photon docs index: https://photon.codes/docs/llms.txt
- Photon support: ryan@photon.codes
