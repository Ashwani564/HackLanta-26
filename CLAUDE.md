# CLAUDE.md

Hackathon project: an iMessage food-recommendation agent. Users (alone or in a group chat) text what they want; the bot recommends specific dishes at nearby restaurants that fit everyone's dietary restrictions, allergies, goals, budget, and walking distance.

## Current state (read this first)

**Where this file and reality differ, this section wins.** The sections below are the original design. What was actually built:
one Lambda (not SQS + worker Lambda), Claude Haiku 4.5 on Bedrock, Photon via a webhook, polls for every choice. Last updated 2026-10-10 (HackLanta '26).

### What it is
An iMessage bot that texts like a friend who knows the food around GSU. "I'm hungry" -> it checks Find My (asks only if you aren't
sharing) -> comments on where you are -> one text naming the 3 nearest places -> poll of those 3 -> two dish picks with prices -> poll to
choose -> quick reaction -> plain-text "want directions?" (Apple Maps link only after a yes). Also: food photo calorie reads, voice notes
both ways, a "Today's Pie" calorie card, contact-card invites, group chats where it only replies when addressed, and
"schedule dinner today with X and Y" (texts each person, settles time and place, reports back; `bot/src/plans.ts`).
Plan polls are multi-pick (counted once they stop tapping, no reply per tap), it asks for Find My locations to pick the fairest place, tells early answerers to hang tight, and ends with a card (`bot/src/meetup-card.ts`).
Full behavior and setup: `bot/README.md`. Code map: `graphify-out/GRAPH_REPORT.md`, then `graphify query "<symbol>"`.

### Where things live
- **Branches:** `main` has the AWS bot (PR #1 merged). **Open PRs, not merged yet:** #2 (don't resend dish picks) and #4 (meal planning).
  `ashar/plan-meals` contains everything including both; work from it until they merge. The user merges PRs themselves (merging is blocked for the assistant).
- **Code:** `bot/` is the bot (Lambda entry `src/lambda.ts`, local entry `src/index.ts`, shared logic `src/handler.ts`). `src/`, `tests/`, `scripts/`, `infra/vector-db.yaml`
  are the retrieval backend (allergen filters, pgvector) that the bot imports; `infra/bot-lambda.yaml` is the bot's stack. `data/` is the GSU menu catalog.
- **AWS (us-east-2, account 446205069613):** stacks `dining-vector-db` (Aurora pgvector, pauses when idle: first query after a pause takes ~15-20 s) and `dining-bot`
  (Lambda `dining-bot`, DynamoDB state table, Function URL, EventBridge rule `rate(1 minute)`). Layer `dining-bot-ffmpeg` (ffmpeg for voice notes). Needs `aws login` (sessions expire).
- **Secrets:** AWS Secrets Manager `photon/project-secret` = `{projectId, projectSecret, webhookSecret}`. Nothing secret is in git. `bot/.env` (gitignored) only holds AWS settings; copy `bot/.env.example`.
  The optional ElevenLabs key is in the macOS Keychain (item `hacklanta-elevenlabs`); the bot uses Amazon Polly/Transcribe by default. Gemini is no longer used.
- **Photon:** project "HackLanta", **Pro plan, but still the shared number pool**: Free and Pro both use shared numbers, so **group chats never reach the bot** (needs the Business plan, a dedicated line).
  People can only text the bot if registered as users (dashboard, or share a contact card with the bot); each user is routed to their own bot number. The webhook points at the Lambda Function URL.
  The Photon CLI is not logged in; the Spectrum API works with the project credentials (`https://spectrum.photon.codes/projects/<id>/...`, basic auth).

### Commands
```bash
cd bot && npm install                      # then: cp .env.example .env
npm run deploy                              # stack + code (needs aws login); `npm run deploy -- --code` for code only
scripts/build-ffmpeg-layer.sh               # once, if the layer is missing (voice notes)
npm run dev                                 # local streaming bot; don't run it while the Lambda is live (both would answer)
npx tsx --env-file=.env chat-sim.mts <scenario>   # talk to the bot with no phone: polls, typed, plan, group, price, allergy, far, never, chat, ...
cd .. && npm test                           # 75 unit tests; `npm run eval` = live allergy eval (26 cases, must say 0 allergen leaks)
aws logs tail /aws/lambda/dining-bot --region us-east-2 --since 15m --format short
aws lambda invoke --region us-east-2 --function-name dining-bot --payload '{"kind":"selftest"}' --cli-binary-format raw-in-base64-out out.json   # ffmpeg + Polly + Transcribe check
graphify update .                           # after code changes; then `git add -f graphify-out/graph.json graphify-out/GRAPH_REPORT.md`
```
Run `npx tsc` in both `bot/` and the repo root before committing (the root build also checks the bot files its tests import).

### Product decisions the user made (don't undo)
- Texts like a person: short, lowercase, no "great question"/"happy to help", no bullet lists; two thoughts = two texts. Never an LLM-sounding reply.
- **Never guess or ask where they are in text.** Check Find My first; ask (card) only if not sharing, once.
- Every choice is a tappable **poll**: 3 nearest places (named in a text first, poll built from the same list), then the 2 dishes. **No yes/no poll for directions** (plain text, link only after yes).
- Dish picks always show the price; if a restaurant lists none (Saxby's, Starbucks), say so once.
- Photos get a short casual calorie read; the model's numbers come from the detected items.
- Group chats: reply only when addressed by name (`BOT_NAMES`), then that person's follow-ups for ~2.5 min.
- Allergens/diets are enforced in code only; the model never says anything is "safe" (a guard rewrites it). Restrictions accumulate per chat and are never forgotten.

### Things that bit us (so they don't again)
- The bot role needs `dynamodb:DeleteItem` (plans release their lock by deleting a row); it was missing once and plan_meal failed with AccessDenied. Plan polls carry `plan: true` so the chat handler never answers their votes.
- Poll votes are read by checking `polls.get` every 2 s (`src/polls.ts`); we haven't confirmed Photon's webhook forwards vote events. Only one vote per person per poll.
- Photon retries slow webhooks, so the Function URL answers fast and an async self-invocation does the work; messages are deduped on id, async retries are off.
- On forced/likely-fumbled first steps the code forces the tool (`wantsFood`, `wantsPlan`, `namesRestaurant` in `src/llm.ts`); the restaurant is read from the user's words, not from what the model passes.
- A tool that already sent its message returns `sent_text`, and the model's follow-up is skipped (it used to repeat the message).
- Find My reads work by **phone number** only (email is blocked on shared plans). `locations.list()` doesn't work on shared plans.
- Available Bedrock models are older only (Haiku 4.5, Sonnet 4.5/4.6, Opus 4.5/4.6); 5.x returns "not available for this account".
- Gemini 3.x "latest" models think for 30-45 s; that's why Gemini was replaced. Polly standard voices only in us-east-2.
- `sharp`, `heif2jpeg` and the gRPC peers must be installed for linux-arm64 in the Lambda zip (the deploy script does it).
- Shell reminder: run commands from the repo root with an absolute `cd`; `npx tsc` outside a project installs a wrong placeholder package.

### Not verified / not done
- The multi-pick plan polls, the location ask and the final card have only been tested in unit tests and `chat-sim plan`; `plan_meal` and the voice notes have **not been tried on real phones** (the poll flow, location flow, photos and Polly/Transcribe on Lambda were).
- Group chats need the Business plan (ask Photon). The group poll logic still takes the first vote as the answer, and restrictions are per chat, not per person.
- Bot has no name yet (set `BOT_NAMES` once chosen). "Today's Pie" card links need `PUBLIC_URL` (a hosted server); SAM 2 photo outlines need a GPU server (`SAM_URL`, Vultr was the idea).
- Demo prep: register judges' numbers as users, warm the database before presenting, record a backup video.
- After the hackathon rotate every key that was pasted into chat (Photon project secret, Gemini, ElevenLabs).

## Non-negotiable rules

1. **Allergens and dietary restrictions are hard filters in code. The LLM never decides safety.**
   - A dish with an unknown allergen field is EXCLUDED for any user with that allergy.
   - The LLM may only choose from dish IDs the code sends it. Validate every returned `dish_id` against the candidate list; drop anything not in it.
   - Any reply that touches allergens ends with a short "confirm with the restaurant" note.
   - `allergen_source = inferred` is weaker than `chart`. Never present inferred data as confirmed.
2. **Never reveal one person's private profile in a group chat.** Say "works for everyone's restrictions", never "since Sam is diabetic…". Goals and health info stay private; only the merged constraints are used.
3. **In group chats, only respond when addressed** (mention or trigger word, see Group chat). Never reply to every message.
4. **No secrets in code, this file, `.mcp.json`, or git.** Use AWS Secrets Manager / env vars / AWS profiles.
5. **Never reply twice to the same message.** Check `ProcessedMessages` before doing any work.

## Stack

- Messaging: Photon Spectrum (`spectrum-ts`, TypeScript). Inbound via Photon webhook; outbound via Photon API. Verify webhook authenticity per Photon docs.
- Backend: AWS. API Gateway → Lambda (Node 22, TypeScript) → SQS → worker Lambda.
- LLM: Amazon Bedrock (Claude). Model ID from `BEDROCK_MODEL_ID` env var, never hardcoded.
- Data: DynamoDB (users, threads, dedupe). Restaurant/dish data is a CSV in S3, loaded into memory.
- Maps: Google Routes API (walking matrix), Geocoding API, Places API (New). Reply links use Apple Maps URLs.
- IaC: AWS SAM (`template.yaml`). Region: `us-east-2` (the project's selected Region; see AWS Agent Toolkit rules below).

## Architecture

```
Photon webhook → API Gateway → webhook Lambda (verify, dedupe, enqueue, return 200 fast)
                                      ↓
                                     SQS
                                      ↓
                worker Lambda: parse → merge profiles → hard filter → score
                               → walking times → LLM pick+explain → reply via Photon
```

- The webhook Lambda must return within ~1s. It does NO LLM or Maps calls.
- The worker sends an immediate tapback or short "on it" message, then does the slow work.
- SQS: set a dead-letter queue; make the worker idempotent.

## Repo layout (target)

```
src/
  webhook/handler.ts        # verify, dedupe, enqueue
  worker/handler.ts         # orchestrates the pipeline
  pipeline/
    parse.ts                # LLM → structured query (tool use / JSON schema)
    profiles.ts             # load + merge user profiles for a thread
    filter.ts               # hard filters (pure functions, unit tested)
    score.ts                # weighted scoring (pure functions, unit tested)
    distance.ts             # haversine prefilter + Google Routes matrix
    explain.ts              # LLM picks 3 from candidates, writes one line each
    format.ts               # iMessage reply text + Apple Maps links
  data/catalog.ts           # load CSV from S3, cache across warm invocations
  db/                       # DynamoDB access (users, threads, processed)
  photon/                   # send message, tapback, parse inbound payload
tests/
  eval/cases.json           # ~25 realistic texts incl. allergy traps
template.yaml
```

## Data: catalog CSV (one row per dish)

```
restaurant_id, restaurant_name, place_id, lat, lng, price_level,
dish_id, dish_name, description, price_usd, category,
calories, protein_g, carbs_g, fat_g, sodium_mg,
allergens, allergen_source, diet_tags, scraped_at
```

- `allergens`, `diet_tags`: pipe-separated (`peanut|soy`, `vegan|gluten_free`).
- `allergen_source`: `chart` | `menu_text` | `inferred`.
- Blank = unknown. Never fill a blank with a guess.
  - Exception (user-approved): Starbucks and Saxby's have no published prices and gaps in their allergen lines. `data/enrich_gaps.py` fills ONLY blanks there with synthetic values, always labeled: `price_source=estimated` (shown as "~$5"), `allergen_source=inferred` (cell `none` = inferred empty), `diet_source=inferred` for added vegan/vegetarian/halal. Stated data is never overwritten. Halal is inferred only for meat-free, alcohol-free items; neither chain is certified. Replies must keep treating `inferred` as unconfirmed.
- `beef` and `pork` are avoidances (diet/religion/health), not allergens. They are matched from dish name and description only (`ALLERGEN_KEYWORDS`), never stored in the allergen cell, and do not require a known allergen cell. "no pork" / "no beef" in `Users.diet` or `allergies` is routed to this path. The `dish_allergen_chart` view exposes `beef`, `pork`, `fish`, `nuts` (tree nut or peanut) and the 9 allergens.
- `Users` profiles (`USERS_TABLE`, PK `phone`, E.164) are read in one-on-one chats only and applied in code on every request; never read into a group chat.
- Do not cache Google Places details long-term; store `place_id` and re-fetch.

## DynamoDB tables

- `Users`: PK `phone`. Fields: `name`, `allergies[]`, `diet[]` (vegan, halal…), `goal` (high_protein, low_sodium, low_cal, none), `budget_max_usd`, `onboarded` (bool), `updated_at`.
- `Threads`: PK `thread_id` (1:1 or group). Fields: `participants[]`, `is_group`, `last_query`, `last_results[]` (dish_ids in order), `pending_members[]`, `updated_at`.
- `ProcessedMessages`: PK `message_id`, TTL ~24h.

## Pipeline details

**Parse** — LLM returns `{location_text?, lat?, lng?, budget_max?, cuisine?, goal?, exclude[], meal_type?, followup?}`. `followup` covers "cheaper", "closer", "not Mexican", "#2": modify `last_query` instead of starting over.

**Location** — shared pin → use coordinates. Typed place → Geocoding / Places Text Search. Nothing → ask "Where are you? Drop a pin or type a spot." Never guess.

**Hard filter** (in order): allergens, diet, open now, haversine ≤ 1.5 km, price ≤ budget, user `exclude`.

**Score** — `0.35*goal_fit + 0.25*distance + 0.20*rating + 0.20*price_fit`, each normalized 0–1. Weights live in one constant so they're easy to tune.

**Walking** — one `computeRouteMatrix` call (`travelMode: WALK`) for the top 10–20 only. Required header `X-Goog-FieldMask`. Map results by `destinationIndex`, parse `duration` (`"512s"`), skip rows where `condition != ROUTE_EXISTS`.

**Explain** — send top 10–15 candidates; LLM picks 3, one line each. Validate IDs.

**Reply** — 3 options max: restaurant, dish, price, walk time, Apple Maps link `https://maps.apple.com/?daddr=LAT,LNG&dirflg=w`. Short. No walls of text.

## Group chat

- **Trigger:** respond only when the message mentions the bot or starts with a trigger word (e.g. "food", "hungry", "where should we eat"). Ignore everything else.
- **Merge rules:**
  - Allergies: union of all members.
  - Diet restrictions: union (if anyone is vegan, results are vegan).
  - Budget: minimum of members' `budget_max`.
  - Goals: soft — averaged into `goal_fit`, never filters.
  - Location: if several members share pins, use `computeRouteMatrix` with multiple origins and minimize the **max** walk time across members. Otherwise use the requester's location.
- **Unknown members:** if a participant has no profile, ask in the thread once: "Anyone with allergies or restrictions? Reply and I'll factor it in." Record their answer to `Users`. Don't block forever — proceed after one round with known constraints and say so.
- **Privacy:** see rule 2. Explanations reference the group, not individuals.

## Onboarding (1:1, first message)

Ask at most 3 things: allergies/restrictions, goal, usual budget. Everything else is per request. "update my profile" works any time.

## Apple Health sync

Apple Health has no cloud API. A Shortcut on the person's iPhone calls `/health/<token>/...` on the bot (`bot/src/health.ts`; recipe in `bot/README.md`).

- **Out to Health:** meals logged in chat (calories, protein, carbs, fat). A missing value is left out, never sent as 0.
- **In from Health:** today's active calories and steps, nothing else, kept 2 days. No clinical records, no conditions.
- **Health data never touches allergen or diet filtering.** It only adjusts the "calories left" talk and the soft goal ranking. Allergies stay chat-collected.
- **1:1 only.** Health numbers are never used or mentioned in a group chat (rule 2).
- **The sync link is a credential.** Send it only in a 1:1 chat; never log it, never put it in chat history or a model prompt.

## Environment / secrets

- Secrets Manager: `photon/project-secret`, `google/maps-key`.
- Env vars: `PHOTON_PROJECT_ID`, `BEDROCK_MODEL_ID`, `CATALOG_S3_URI`, `AWS_REGION`, table names, `HEALTH_SHORTCUT_URL` (iCloud link of the shared shortcut; unset means Health sync is off).
- Google key restricted to Routes, Geocoding, Places APIs. Billing budget alert set.

## Testing

- `filter.ts` and `score.ts` are pure functions with unit tests. Allergy filtering must have tests.
- `tests/eval/cases.json`: ~25 texts (messy, typos, follow-ups, group merges, allergy traps such as "allergic to peanuts, recommend Thai"). Run before every demo. **Zero allergen leaks is the pass bar.**

## Out of scope (for the hackathon)

Ordering/payments, DoorDash, Apple Health clinical records (allergies, conditions, medications) and any other medical data, nationwide coverage, vector search/embeddings. Demo covers one neighborhood.

## Working style for Claude

- Keep functions small and pure where possible; side effects live in handlers, `db/`, and `photon/`.
- Ask before adding a new AWS service or dependency.
- When unsure about a Photon SDK API, check docs.photon.codes rather than guessing.

<!-- BEGIN AWS Agent Toolkit rules -->
# AWS Guidance for the new AWS experience

This user has signed up for the new AWS experience. This experience lets you sign into AWS using a social provider and requires the following additional context.

Where this guidance conflicts with the project's own instructions, the project's instructions take precedence.

## Context

### Terminology:

- Say "project" instead of "account" — a project contains an AWS account and settings for sharing with other collaborators
- Say "team member" instead of "IAM user" — users are invited by email, not created or federated in IAM
- Say "AWS Settings" when referring to management tasks at [settings.aws.com](https://settings.aws.com/) (project management, billing, team members, spend limits). Users view their actual AWS resources in the AWS Management Console.
- Say "selected Region" when referring to the user's Region — not "home Region"
- The user has a managed IAM experience. This includes a managed service control policies (SCP) and resource control policies (RCP) that govern the use of AWS. They will still need to use IAM to create policies to let services work with each other. If there are questions about the SCPs or RCPs, go to the documentation at https://docs.aws.amazon.com/accounts/latest/reference/scps-and-rcps-for-projects.html

### Constraints:

- All projects share a single AWS Region determined by the user's contact address. Resources cannot be created in other Regions
- When developing:
  - MUST create all Regional resources in the project's assigned Region
  - You CAN create AWS WAF and Cloudwatch Logs resources in us-east-1 when there are global resources (like a global WAF instance) that require a connection to dependencies in us-east-1. You should not use these for any other reason, because resources in the selected Region will provide lower cost (due to no cross-Region traffic), increased availability (due to no cross-Region traffic), and easier manageability (due to not needing to look in another Region). When you need to do an inventory of resources, you need to look in both the selected Region and us-east-1 for Cloudwatch Logs or WAF resources.
  - MUST NOT attempt to create Lambda, API Gateway, or other Regional resources in any other Region
  - MUST direct users to confirm their Region in AWS Settings > View all projects > Overview > Additional Info > Region. If the user cannot confirm their Region, check in ~/.aws/config
  - MUST NOT use Lambda@Edge — excluded from both Lambda and CloudFront
  - MUST NOT use CloudFormation StackSets — no multi-account or multi-Region deployments
  - MUST NOT attempt cross-Region actions — no cross-Region replication for DynamoDB/S3/RDS, no multi-Region KMS keys
  - MUST NOT use Route 53 cross-Region routing — geolocation, latency-based, and failover routing policies are not available
  - CloudFront is a global service and its actions ARE allowed in `us-east-1`. A user can create a CloudFront distribution pointing to their project-region Lambda function URL or API Gateway. However, Lambda and API Gateway themselves MUST NOT be created in `us-east-1` — they must be in the project Region.
  - Reduced availability in `eu-north-1` specifically: Amazon Rekognition, Amazon Textract, Amazon Personalize, AWS App Runner are not available in that Region.
- IAM permissions for human access are managed by AWS. Don't assign roles to team members unless absolutely necessary
- The user may have a spend limit if they are on the paid plan. The limit that pauses their project if it's exceeded. If resources suddenly become inaccessible, ask if they have a spend limit configured. Only project owners can modify a spend limit.
- When developing:
  - MUST ask about spend limit status if the user reports sudden "Access Denied" errors on operations that previously worked
  - MUST direct users to check spend status in AWS Settings > Billing
  - MUST check if a user has upgraded their account to the paid plan
  - MUST ask the user if they want to clean up the successfully created resources or keep them to reduce cost
- The user sets up billing, creates spend limits, and retrieves and pays invoices in AWS Settings. The user creates budgets and optimizes their costs in the AWS Billing and Cost Management console
- Not all AWS services are available. If a service isn't working, do the following:
  1. Run the command `aws freetier get-account-plan-state`
  2. If accountPlanType": "FREE", check the [Free Tier supported services list](https://docs.aws.amazon.com/accounts/latest/reference/supported-services-sign-up-new.html#supported-services-free-tier) next,
  3. If accountPlanType": "PAID", check the [Paid Tier supported services list](https://docs.aws.amazon.com/accounts/latest/reference/supported-services-sign-up-new.html#supported-services-paid-plan).
  4. If neither list shows the service, check the [Not supported for this experience list](https://docs.aws.amazon.com/accounts/latest/reference/supported-services-sign-up-new.html#unsupported-services). The user will need to activate advanced features to access this service.
- Users can activate advanced AWS services and capabilities for their account.
- Before starting a task, check whether a relevant AWS skill is available. Load the skill with retrieve_skill and prefer its guidance over general knowledge.

### Help level

- help_level (required): LOW, MEDIUM, or HIGH. While a user is building, you MUST ask the user: "How much guidance would you like from me? Low (I only flag security risks), medium (I ask a couple of clarifying questions if something seems off), or high (I explain what I'm doing, suggest alternatives, and flag best practices)."

You CAN update this rule file to save a user's help_level.

Constraints for each level:

**LOW:**

- MUST follow all constraints in this context file
- MUST execute the user’s request without modification
- MUST NOT ask clarifying questions unless the action would create a security vulnerability
- MUST NOT suggest alternatives or improvements

**MEDIUM:**

- MUST execute the user's request
- MAY ask up to two clarifying questions per task if the request has an ambiguity or a potential issue
- MUST NOT repeat a question or suggestion the user has already dismissed
- MUST NOT explain trade-offs or alternatives unless the user asks

**HIGH:**

- MUST explain what each step does and why before executing it
- MUST suggest alternatives when a better approach exists
- MUST flag best practices and explain trade-offs
- MUST still execute the user's choice if they disagree with a suggestion

<!-- END AWS Agent Toolkit rules -->

## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

Rules:
- For codebase questions, first run `graphify query "<question>"` when graphify-out/graph.json exists. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).
