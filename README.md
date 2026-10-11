# Snacxx: the friend in your iMessage who already knows what you can eat

**Snacxx is an iMessage agent built on Photon Spectrum. Text it "i'm hungry" and it finds the nearest places with food you can actually eat, at a price you can afford, and lets you tap your way to a dish. Ask it to plan dinner with friends and it texts each of them, settles a time and a place that works for everyone, and sends back a card.**

Built at HackLanta '26.

## Inspiration

**44% of Americans have dietary restrictions, and 83% overspend their monthly budget, mostly on dining out.**

Food apps today suggest restaurants based on how close they are. They don't look at you. None of them takes your diet, your allergies, your calorie and protein goals and how active you've been today, and then points you to a dish nearby that fits all of it and your budget.

Group outings are harder still. No app finds a place that matches everyone's diet, budget and location, settles on a time that works for all of them, and schedules it.

Snacxx does both, inside iMessage.

## What it does, and the Photon feature behind each step

| You text | Snacxx replies | Photon feature | How it works |
|---|---|---|---|
| **"i'm hungry"** | A quick remark on where you are, the 3 nearest places you can eat at with walk times, then a poll of those 3 | Find My location, native polls | Reads your Find My location. If you aren't sharing, it sends a share card once and waits for your tap. It then keeps only the places with food that fits your allergies, diet and budget. |
| *Tap a place in the poll* | Two dish picks with prices, then a poll to choose one | Native polls, typing indicator | Reads your tap, filters that menu for your restrictions, and picks the two best matches. |
| *Tap a dish* | A quick reaction with calories and protein, then "want directions?" | Native polls | The Apple Maps walking link is sent only after you say yes. |
| **"schedule dinner today with sam and maya"** | "on it, texting them." Each friend gets a poll of times and a poll of places. Everyone gets a card with the place, time, who's coming and their walk. | Direct messages, multi-select polls, Find My location, link cards | Texts each person in their own private chat, waits until they stop tapping, picks the time most people can do and the place that fits everyone's restrictions with the fairest walk. |
| *A photo of your food* | A 👀 reaction, then a short read: calories, protein, the biggest item | Photo attachments, tapback reactions | Claude looks at the photo and estimates each item on the plate. |
| *A voice note* | A voice note back | Voice messages | The note is transcribed, answered, and spoken back. |
| **"i had a burrito"** or **"how's my day"** | The Today's Pie card: calories, protein and budget left today | App cards, updated in place | Logs the meal and updates the same card all day, so the chat doesn't fill up with new messages. |
| **"connect apple health"** | A private setup link, then "ok you're connected" once your phone syncs | Proactive messages | An Apple Shortcut writes your logged meals to Apple Health and sends back today's active calories and steps. |
| *A friend's contact card* | A 👍 reaction and "ok, texted sam" | Contact cards, user registration | Signs your friend up and sends them an intro, so they can be part of your plans. They can reply STOP at any time. |

## How it works

<img width="2394" height="1332" alt="Image 10-11-26 at 6 20 AM" src="https://github.com/user-attachments/assets/e1fcc661-2845-4232-9089-bb0cedb12b42" />


Photon Spectrum delivers every iMessage to Snacxx and carries back everything it sends. Snacxx runs as one serverless function on AWS Lambda. Claude on Amazon Bedrock handles the conversation. The restaurant menus live in Amazon Aurora, and Amazon DynamoDB remembers chats, meals and group plans. Amazon Polly and Transcribe handle voice notes. A scheduler on Amazon EventBridge moves group plans along every minute, and an Apple Shortcut syncs steps and active calories from Apple Health.

**Built with:** Photon Spectrum · AWS Lambda · Amazon Bedrock (Claude) · Amazon Aurora · Amazon DynamoDB · Amazon S3 · Amazon EventBridge · Amazon Polly · Amazon Transcribe · Apple Shortcuts · Apple Health · Find My · Apple Maps · TypeScript

## Why it fits what Photon is looking for

Snacxx is **hybrid intelligence** in a simple division of work: people make every choice, the AI handles the conversation, and fixed rules handle safety.

- **Real human-in-the-loop collaboration.** Snacxx narrows the options and the person taps. It never guesses where you are and never sends directions before you say yes. In a group plan, the time most people picked wins, and anyone it doesn't suit is asked directly.
- **Context-awareness that persists across time, channels, and teammates.** An allergy you mention once is remembered. A text, a tap, a voice note and a photo all feed the same conversation. A dinner plan lives across several people's private chats and keeps moving while they answer at their own pace.
- **A delightful default that doesn't demand attention.** If you already share Find My, it asks nothing. It doesn't reply to every tap. In a group chat it stays quiet unless someone says its name. It texts like a friend: short, lowercase, no lists.
- **Thoughtful safety and fallback behaviors that earn trust.** See the next two sections.

## How your data is collected and used

Everything Snacxx knows about you comes from your own text or tap.

| Data | How Snacxx gets it | How it is used |
|---|---|---|
| **Allergies, diet, budget** | You say it once, in chat | Dishes that don't fit are removed before the AI ever sees them. Never mentioned in a group or to friends in a plan. |
| **Location** | Your tap on a Find My share card | Nearest places and walk times. Kept 45 minutes. The AI is told a place name, never your coordinates. |
| **Meals and goals** | "i had a burrito," "set my goal to 1800" | The Today's Pie card, and a nudge toward lighter or higher-protein picks |
| **Apple Health** | Opt-in, through an Apple Shortcut you run | Your meals go into Health. Active calories and steps come back to adjust your day. Activity only, never medical records. |
| **Friends** | A contact card you share | One intro text. They can opt out with STOP. |

In a group plan, each person's restrictions are read from their own chat and combined. All anyone hears is "4 of 9 places work for everyone," never whose allergy ruled out the rest.

## Safety and fallbacks

- **Allergies and diets are enforced by rules, not by the AI.** The AI only chooses among dishes that already passed.
- **Unknown means hidden.** If we don't know what's in a dish, it isn't shown to anyone with an allergy.
- **It never calls a dish "safe."** Every allergy reply ends with "double check with them before you order."
- **It never replies twice** to the same message, even if a delivery is retried.
- **When something goes wrong, it says so.** If a poll can't be sent, it asks in plain text. If you type an answer, it follows along. If you're too far away or nothing fits your restrictions, it tells you and does not guess.

## What's in this repo

| Folder | What it is |
|---|---|
| [`bot/`](bot/) | The Snacxx agent. Full setup, the Apple Health shortcut and known limits are in [`bot/README.md`](bot/README.md). |
| `src/`, `scripts/`, `tests/` | Menu search and the allergy, diet and budget filters the agent uses, with their tests |
| `infra/` | AWS templates for the agent and the menu database |
| [`data/`](data/) | The menu catalog: 9 restaurants around Georgia State's campus |

## Run it

```bash
cd bot
npm install
cp .env.example .env     # AWS settings only; Photon credentials live in AWS Secrets Manager
npm run terminal         # chat with Snacxx in your terminal, no phone needed
npm run dev              # local iMessage bot; don't run it while the Lambda is live (both would answer)
npm run deploy           # deploy to AWS Lambda (needs `aws login`)
```

Tests run from the repo root:

```bash
npm install
npm test                 # 138 unit tests, no AWS needed
npm run eval             # live allergy eval; the pass bar is zero allergen leaks
```

Nothing secret is in git. Never commit real keys.

## What's next

- A dedicated Photon line, so Snacxx can sit inside real group chats
- More neighborhoods and restaurants
- Real walking routes in place of distance estimates
- A "what do you know about me?" reply that lists everything saved and lets you delete it

## Saving AI tokens with graphify

This repo ships a [graphify](https://github.com/safishamsi/graphify) code map (`graphify-out/graph.json` + `GRAPH_REPORT.md`) so Claude Code can query the codebase structure instead of re-reading files. One-time setup per teammate:

```bash
uv tool install graphifyy    # installs the `graphify` CLI
graphify hook install        # git hooks: rebuild the map after each commit/checkout (local only)
```

- Claude Code picks it up automatically via `.claude/settings.json` and the `CLAUDE.md` rules (the hook is skipped if graphify isn't installed).
- Ask questions with `graphify query "how does X work"`, `graphify explain "annotateFood"`, `graphify path "handle" "sendDayCard"`.
- After code changes: `graphify update .` (local AST parsing, no API key or cost). Commit the refreshed `graph.json`/`GRAPH_REPORT.md` with `git add -f`.
