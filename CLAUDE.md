# CLAUDE.md

Hackathon project: an iMessage food-recommendation agent. Users (alone or in a group chat) text what they want; the bot recommends specific dishes at nearby restaurants that fit everyone's dietary restrictions, allergies, goals, budget, and walking distance.

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
- IaC: AWS SAM (`template.yaml`). Region: `us-east-1` unless changed here.

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

## Environment / secrets

- Secrets Manager: `photon/project-secret`, `google/maps-key`.
- Env vars: `PHOTON_PROJECT_ID`, `BEDROCK_MODEL_ID`, `CATALOG_S3_URI`, `AWS_REGION`, table names.
- Google key restricted to Routes, Geocoding, Places APIs. Billing budget alert set.

## Testing

- `filter.ts` and `score.ts` are pure functions with unit tests. Allergy filtering must have tests.
- `tests/eval/cases.json`: ~25 texts (messy, typos, follow-ups, group merges, allergy traps such as "allergic to peanuts, recommend Thai"). Run before every demo. **Zero allergen leaks is the pass bar.**

## Out of scope (for the hackathon)

Ordering/payments, DoorDash, Apple Health, storing medical data, nationwide coverage, vector search/embeddings. Demo covers one neighborhood.

## Working style for Claude

- Keep functions small and pure where possible; side effects live in handlers, `db/`, and `photon/`.
- Ask before adding a new AWS service or dependency.
- When unsure about a Photon SDK API, check docs.photon.codes rather than guessing.
