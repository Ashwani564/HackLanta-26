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
always answers. The bot is called Snacxx (`BOT_NAMES`, comma-separated, defaults to `snacxx,bot,food bot,dining agent`). Groups only reach the bot on Photon's Business
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
npm run start:free   # no AWS at all: Photon streaming + a free LLM + local files (see "Running with no AWS")
npm run deploy       # build + deploy the Lambda stack (infra/bot-lambda.yaml), then it prints the webhook URL
npm run deploy -- --code    # code only, skip the stack
npm run typecheck
```

After the first deploy, register the Function URL as your Photon webhook and store its signing secret in the same
secret as `webhookSecret` (see `src/lambda.ts`). Don't run the local bot and the Lambda at the same time: both would answer.

Try the conversation without iMessage: `npx tsx --env-file=.env chat-sim.mts polls` (fakes Find My and poll taps; Bedrock and the database are real).

## Apple Health sync

Apple Health has no cloud API, so a Shortcut on the person's iPhone does the syncing. It calls three routes on the
bot (`src/health.ts`), authenticated by a per-person token in the path:

```
GET  /health/<token>            the person's setup page (their sync link, opened in a browser)
GET  /health/<token>/status     { synced_at }  when the phone last synced; the setup page polls this
GET  /health/<token>/pending    meals logged in chat today that aren't in Health yet
POST /health/<token>/ack        { ids }  mark those meals as written
POST /health/<token>/metrics    { active_kcal, steps, weight_kg | weight_lb }  numbers read from Health
```

**Try it against your laptop** (phone and laptop on the same Wi-Fi; allow Node through the firewall if asked):

```bash
npx tsx scripts/health-demo.ts     # logs two sample meals, prints the sync link; Enter logs another
```

Open the printed link in Safari on the phone: it's the setup page, with a Copy button for the link itself.

**Build the "Pie Sync" shortcut** (Shortcuts app → + → name it Pie Sync):

1. **Text**: paste the sync link (everything up to and including the token, no trailing slash).
2. **Get Contents of URL**: URL is the `Text` variable followed by `/pending`. Method GET.
3. **Get Dictionary Value**: Get `Value` for `meals` in `Contents of URL`.
4. **Repeat with Each** item in `Dictionary Value`. Inside the loop:
   - **Log Health Sample**: Type `Dietary Energy`, Unit `kcal`, Value = `Repeat Item` (tap it → Get Value for Key `calories`).
   - **Log Health Sample**: Type `Protein`, Unit `g`, Value = `Repeat Item` → key `protein`.
   - **If** `Repeat Item` → key `carbs` *has any value*: **Log Health Sample**, Type `Carbohydrates`, Unit `g`, that value. End If.
   - **If** `Repeat Item` → key `fat` *has any value*: **Log Health Sample**, Type `Total Fat`, Unit `g`, that value. End If.
   - **Add to Variable**: add `Repeat Item` → key `id` to a variable named `Synced`.
5. After End Repeat, **Get Contents of URL**: URL is `Text` followed by `/ack`. Method POST, Request Body JSON, one
   Text field `ids` = the `Synced` variable.

Each Log Health Sample must use the value from the step **directly above it**. Every one of them shows as
"Dictionary Value" in the editor, so it is easy to pick the wrong one (the `id`, say) and log a wrong number: choose
Select Variable and tap the bubble under the right step. The demo's sample meals carry carbs and fat so a mistake
shows up in Health → Nutrition → Carbohydrates and Total Fat (42 g and 9 g for the first meal).

Leave the Date on the Log Health Sample actions empty: the meal is stamped with the time the shortcut runs.
`carbs` and `fat` are missing from a meal when nobody estimated them, which is why those two sit inside an If.

**Check it**: run the shortcut, allow the connection and the Health write access it asks for, then open
Health → Browse → Nutrition → Dietary Energy → Show All Data. The sample meals are there with source Shortcuts.
Run it again: nothing new is added. Press Enter in the demo, run it once more: one new entry.

**Add the read half** (after the `/ack` request), so the bot knows how active the day was:

6. **Find Health Samples** where Type is `Active Energy` and Start Date is today → **Calculate Statistics** (Sum) →
   **Set Variable** `Active`. If the action offers a unit, pick `kcal`.
7. **Find Health Samples** where Type is `Steps` and Start Date is today → **Calculate Statistics** (Sum) →
   **Set Variable** `Steps`.
8. **Get Contents of URL**: URL is `Text` followed by `/metrics`. Method POST, Request Body JSON, fields
   `active_kcal` = `Active` and `steps` = `Steps`.

Press Enter in the demo afterwards: it prints what arrived. The reads only work while the phone is unlocked, which
is why they come last; a failed read can't undo or repeat the meals already written.

**Share it** so the bot can hand it out. In the shortcut's details (ⓘ) → Setup, add an Import Question on the Text
action ("Paste the link I texted you"), then Share → Copy iCloud Link. Keep the name `Pie Sync`: the setup page's
buttons run it by name. Editing a shared shortcut does not change the old link; copy a new one. Give the link to the bot:

```bash
HEALTH_SHORTCUT_URL=https://www.icloud.com/shortcuts/... npm run deploy    # stored on the stack; later deploys keep it
```

Locally, put `HEALTH_SHORTCUT_URL` and `PUBLIC_URL` (the address phones reach this machine on) in `.env`.

**In chat**: "connect apple health" makes the bot text the person their private sync link (one-on-one chats only;
in a group it asks them to message it directly). Opened in a browser, that link is a setup page:

1. **Copy your link**: its own step, and the button says whether the copy worked. (Copying inside the Add tap
   failed silently on a real iPhone; the wrong thing then gets pasted and the shortcut calls the wrong address,
   which shows up as "couldn't convert from Rich Text to Dictionary".)
2. **Add the shortcut**: opens the prebuilt shortcut; they paste the link when Shortcuts asks.
3. **Run it once** (the **Test It** button): runs the shortcut, they approve the connection and Health access, and the page turns to "Connected".
   The bot also texts them once to say it worked. The button then becomes **Sync Now**.

Nothing runs by itself after that: meals reach Health when the person taps **Sync Now** on the page or runs Pie Sync
in Shortcuts. (The page doesn't walk people through a Message automation; anyone who wants it hands-free can add
one in Shortcuts that runs Pie Sync when the bot texts.)

**What the bot does with the numbers** (one-on-one chats only, never in a group): half of the day's active calories,
up to 500, count as extra room when it talks about what's left, and when the day is running low on calories or
behind on protein the dish ranking leans lighter or higher-protein. That's a nudge to the order, never a filter;
allergy and diet filtering doesn't look at any of this. The numbers are kept for two days.

**Health Auto Export instead of the read half**: that App Store app can send the same numbers on a schedule, with
no shortcut actions to build. In it: Automations → New Automation → REST API, URL `<sync link>/metrics`, Data Type
Health Metrics (select only Active Energy and Step Count), Export Format JSON, Summarize Data on, Date Range Today.
It only reads; writing meals into Health still needs the shortcut.

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
│   ├── health.ts     # Apple Health sync routes: sync tokens, pending meals, acks, numbers from Health
│   ├── store.ts      # DynamoDB in Lambda, in-memory locally
│   ├── secrets.ts    # Photon credentials from Secrets Manager
│   └── invite.ts     # contact-card invites, STOP opt-out
├── scripts/          # deploy-lambda.sh, send.ts, card/plan/health demos
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

## Running with no AWS

`npm run start:free` runs the whole bot on this machine with no AWS account. It reads `.env.free` (Photon project id and secret, optional `ELEVENLABS_API_KEY`, `LLM_PROVIDER=free`).

- **Model**: a free OpenAI-compatible endpoint (`FREE_LLM_URL`, default Pollinations, no key; `FREE_LLM_MODEL`, default `openai-fast`). It is rate-limited, so calls are queued about 20 s apart and replies are slower. Food, plans and restaurant names are started in code; the model only picks meal logging, goals, the day card, dish picks and directions by itself.
- **Menus**: `data/gsu_dishes.csv` in memory, ranked by word overlap, through the same hard allergy and diet filters.
- **State**: saved to `.snacxx-state.json`; profiles are read from `users.local.json`. Both are gitignored.
- **Off**: photo calorie reads (need a vision model) and Apple Health sync (needs a public URL). Voice uses ElevenLabs if its key is set.
- Before starting it, run `npx tsx scripts/unwebhook.mts` so the Lambda stops answering too. `bash scripts/rewebhook.sh` points Photon back at the Lambda.
