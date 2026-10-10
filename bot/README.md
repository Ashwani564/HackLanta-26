# iMessage dining agent (bot)

An iMessage bot that helps you decide what to eat, texting like a friend who knows the spots around GSU.
It runs on [Photon Spectrum](https://photon.codes/docs/spectrum-ts/introduction) for iMessage and on AWS:
Claude on Bedrock for the chat, Aurora pgvector for the menus, Polly/Transcribe for voice, DynamoDB for state.
No Gemini and no third-party AI keys.

## What it does

**"I'm hungry"** goes through one flow, and every choice is a tappable iMessage poll:

1. It never guesses where you are. If you aren't sharing, it asks casually and sends a Find My request card, then waits for you to tap share.
2. It reads your location, comments on where you are, and polls you with the nearest restaurants that have food you can eat (with walk times).
3. You pick a spot, and it sends two dish picks from that restaurant, then a poll to choose one.
4. It reacts to your pick (calories, protein) and polls "want directions?". The Apple Maps link is sent only if you say yes.

You can type instead of tapping and it follows along. Other things it does:

| Text the bot | What happens |
|---|---|
| A food photo | A quick casual read: total calories and protein and the biggest chunk. With a SAM 2 server (`SAM_URL`) it sends the photo back outlined and labeled instead. |
| "i had a burrito" / "how's my day" | Logs meals and shows the "Today's Pie" card, edited in place. |
| "make a poll for dinner" | A native iMessage poll. |
| A voice note, or "send me a voice note" | Transcribed with Amazon Transcribe, answered with Amazon Polly (Mac host only for now, see limits). |
| A friend's contact card | Registers them as a Photon user and texts them an intro. They can reply STOP. |
| `/reset` | Clears the chat's memory, restrictions and saved location. |

**Allergies and diets are enforced in code, never by the model.** Every dish passes the SQL filters and a second code check
(`src/pipeline/filter.ts`) before the model sees it, restrictions mentioned anywhere in a chat accumulate and are never forgotten,
and allergy wording ("double check with them…") is added by code. A guard rewrites any model text that claims something is
"safe" or "allergen-free".

## Architecture

```
iMessage -> Photon -> Lambda Function URL (verify HMAC, answer 200 fast)
                         └─> async self-invoke: Claude (Bedrock) + tools
                               ├ Aurora pgvector (dishes, allergen filters)   ├ Photon Find My + polls
                               ├ DynamoDB (chat history, meals, dedupe)       └ Polly / Transcribe
```

Photon only needs the fast 200. The async run can take minutes: after sending a poll it waits for the tap.

## Setup

Requirements: Node 20.6+, an AWS login (`aws login`) with Bedrock access to Claude Haiku 4.5, the `dining-vector-db` stack
from `../infra/vector-db.yaml` (ingested with `npm run ingest` in the repo root), and a Photon project.

```bash
cd bot
npm install
cp .env.example .env     # AWS settings only; Photon keys live in Secrets Manager
```

Store the Photon credentials once (the bot reads them at startup):

```bash
aws secretsmanager create-secret --region us-east-2 --name photon/project-secret \
  --secret-string '{"projectId":"...","projectSecret":"..."}'
```

On Photon's Free/Pro plans the bot can only message people added as **users** (dashboard, or share a contact card with the bot).

## Run

```bash
npm run dev          # local streaming bot (needs this Mac awake), auto-restarts
npm run terminal     # local chat UI in your terminal, no Photon needed
npm run deploy       # build + deploy the Lambda stack (infra/bot-lambda.yaml), then it prints the webhook URL
npm run deploy -- --code    # code only, skip the stack
npm run typecheck
```

After the first deploy, register the Function URL as your Photon webhook and store its signing secret in the same
secret as `webhookSecret` (see `src/lambda.ts`). Don't run the local bot and the Lambda at the same time: both would answer.

Try the conversation without iMessage: `npx tsx --env-file=.env chat-sim.mts polls` (fakes Find My and poll taps; Bedrock and the database are real).

## Layout

```
bot/
├── src/
│   ├── lambda.ts     # webhook entry: verify, ack, async self-invoke, dedupe
│   ├── index.ts      # local streaming entry (same handler)
│   ├── handler.ts    # message routing, tools, poll loop (send poll -> wait for tap -> next step)
│   ├── llm.ts        # persona prompt, tools, tool loop on Bedrock, NO_REPLY + safety-claim guard
│   ├── dining.ts     # nearby restaurants, two dishes, restrictions, the choice polls
│   ├── polls.ts      # send a poll, read the vote
│   ├── findmy.ts     # Find My: ask casually, request card, wait for share
│   ├── photon.ts     # shared low-level Photon client
│   ├── vision.ts     # food photo: Claude finds items + calories (grid-assisted boxes), optional SAM 2 masks
│   ├── voice.ts      # Polly + Transcribe (ElevenLabs optional)
│   ├── day.ts, card.ts, day-art.ts, plan.ts, web.ts   # calorie tracking cards and dashboard
│   ├── store.ts      # DynamoDB in Lambda, in-memory locally
│   ├── secrets.ts    # Photon credentials from Secrets Manager
│   └── invite.ts     # contact-card invites, STOP opt-out
├── scripts/          # deploy-lambda.sh, send.ts, card/plan demos
├── vision-server/    # optional SAM 2 service (npm run vision)
└── chat-sim.mts      # local conversation simulator
```

## Known limits

- **Voice notes need macOS** (`afconvert`); on Lambda the bot asks people to type. Adding an ffmpeg layer fixes it.
- **Polls**: votes are read by checking the poll's state every 2 s, because it isn't known that Photon's webhook forwards vote events. If you type an answer instead, the typed path takes over.
- **Group chats** need Photon's Business plan (shared lines can't create or see groups).
- **Coverage** is the 9 restaurants around GSU. Far from campus, the bot says so instead of guessing.
- **Allergen data** is mostly estimated; the bot says so and always tells people to confirm with the restaurant.
- The database pauses when idle; the first query after a pause takes ~15-20 s. The bot wakes it while you're tapping share.
