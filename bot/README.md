# iMessage dining agent (bot)

An iMessage bot that helps you decide what to eat, texting like a friend who knows the spots around GSU.
It runs on [Photon Spectrum](https://photon.codes/docs/spectrum-ts/introduction) for iMessage and on AWS:
Claude on Bedrock for the chat, Aurora pgvector for the menus, Polly/Transcribe for voice, DynamoDB for state.
No Gemini and no third-party AI keys.

## What it does

**"I'm hungry"** goes through one flow, and every choice is a tappable iMessage poll:

1. It never guesses where you are. It checks Find My first; if you're already sharing it just uses it. Only if you aren't does it ask casually, send a Find My request card (once), and wait for you to tap share.
2. It comments on where you are, sends one text naming the three nearest places with food you can eat (with walk times, not two of the same kind), then a poll of exactly those three.
3. You pick a spot, and it sends two dish picks from that restaurant, then a poll to choose one.
4. It reacts to your pick (calories, protein) and asks "want directions?" in plain text. The Apple Maps link is sent only if you say yes.

You can type instead of tapping and it follows along. Other things it does:

| Text the bot | What happens |
|---|---|
| A food photo | A quick casual read: total calories and protein and the biggest chunk. With a SAM 2 server (`SAM_URL`) it sends the photo back outlined and labeled instead. |
| "i had a burrito" / "how's my day" | Logs meals and shows the "Today's Pie" card, edited in place. |
| "make a poll for dinner" | A native iMessage poll. |
| A voice note, or "send me a voice note" | Transcribed with Amazon Transcribe, answered with Amazon Polly as a voice message (needs ffmpeg, see limits). |
| A friend's contact card | Registers them as a Photon user and texts them an intro. They can reply STOP. |
| `/reset` | Clears the chat's memory, restrictions and saved location. |

**Planning a meal with friends:** say "schedule dinner today with ashwani and princy" (or "grab dinner with ashwani and princy, figure
out the time and place") and the bot texts each of them separately (they must be registered users). Everyone gets a poll of times where
they **tap every time that works**; the bot says nothing per tap and counts the answer once they stop changing it (`PLAN_SETTLE_SEC`,
15 s). It also asks each person to share their location (Find My) so the place can be fair to everyone. The time the most people ticked
wins; anyone who can't do it is asked "does 7:00 work?". Anyone who has answered while others haven't hears "hang tight while i check
with the others". Then everyone polls (again multi-pick) on the three places that fit **everyone's** allergies and diets and are
closest to where everyone is (shortest worst-case walk; each person sees their own walk time); people who haven't shared get
`PLAN_LOC_WAIT_MIN` (3 min) before it goes with who it has. Most ticks wins, and everyone gets a card (`src/meetup-card.ts`) with the
place, time, date, who's coming and each person's walk. People can type instead of tapping ("7 works", "can't tonight"). Quiet people
get one nudge after 10 minutes and are dropped after 40 (`PLAN_NUDGE_MIN`, `PLAN_GIVE_UP_MIN`). Plans are saved, and an EventBridge
check every minute (or a 30 s timer when running locally) reads the answers and moves them forward, so they survive restarts.
Code in `src/plans.ts`; try it without texting anyone: `npx tsx --env-file=.env chat-sim.mts plan`.

**Group chats:** the bot stays quiet unless someone talks to it ("hey bot, where should we eat"). That person's follow-ups
count for a couple of minutes; everyone else's chatter is dropped before anything reads or stores it. In one-on-one chats it
always answers. Set `BOT_NAMES` (comma-separated) once the bot has a name. Groups only reach the bot on Photon's Business
(dedicated line) plan; Free and Pro use the shared pool, which can't see group chats.

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
│   ├── plans.ts      # "schedule dinner with…": text each person, settle time and place, report back
│   ├── dm.ts         # text one person directly
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

- **Voice notes on Lambda need an ffmpeg layer** (`scripts/build-ffmpeg-layer.sh`, then `npm run deploy`). Without it the bot asks people to type. Check it with `aws lambda invoke --function-name dining-bot --payload '{"kind":"selftest"}' --cli-binary-format raw-in-base64-out out.json`. Locally, ffmpeg from your PATH is used (macOS `afconvert` is the fallback).
- **Polls**: votes are read by checking the poll's state every 2 s, because it isn't known that Photon's webhook forwards vote events. If you type an answer instead, the typed path takes over.
- **Group chats** need Photon's Business plan: Free and Pro are both the shared pool, which can't create or see groups. The "only when addressed" logic is built and tested but dormant until groups reach the bot. Group flows also still treat the first vote as the answer and keep restrictions per chat, not per person.
- **Coverage** is the 9 restaurants around GSU. Far from campus, the bot says so instead of guessing.
- **Allergen data** is mostly estimated; the bot says so and always tells people to confirm with the restaurant.
- The database pauses when idle; the first query after a pause takes ~15-20 s. The bot wakes it while you're tapping share.
