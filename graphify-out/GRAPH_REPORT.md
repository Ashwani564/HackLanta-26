# Graph Report - HackLanta-26  (2026-10-10)

## Corpus Check
- 75 files · ~65,517 words
- Verdict: corpus is large enough that graph structure adds value.
- Unclassified: 8 file(s) not represented in the graph (top: .csv 3, .example 2, (none) 2)

## Summary
- 728 nodes · 1668 edges · 37 communities (31 shown, 6 thin omitted)
- Extraction: 99% EXTRACTED · 1% INFERRED · 0% AMBIGUOUS · INFERRED: 21 edges (avg confidence: 0.87)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `73990a96`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- dependencies
- day.ts
- bot/package.json
- build_gsu_dataset.py
- plan-demo.ts
- vision.ts
- scripts
- compilerOptions
- plans.ts
- devDependencies
- vision-server
- dining.test.ts
- rag/store.ts
- parse.ts
- voice.ts
- package.json
- filter.ts
- CLAUDE.md
- pipeline.test.ts
- iMessage dining agent (bot)
- lambda.ts
- recommend.ts
- dining.ts
- findmy.ts
- handler.ts
- score.ts
- compilerOptions
- putState
- format.ts
- deploy-lambda.sh
- build-ffmpeg-layer.sh
- vision-server/README.md
- graphify
- .mcp.json
- invite.ts
- polls.ts
- embed.ts

## God Nodes (most connected - your core abstractions)
1. `createHandler()` - 52 edges
2. `handle()` - 43 edges
3. `putState()` - 29 edges
4. `stagePlace()` - 21 edges
5. `startPlan()` - 20 edges
6. `restaurantDishes()` - 17 edges
7. `chat()` - 15 edges
8. `advance()` - 15 edges
9. `PlanDeps` - 14 edges
10. `stageTime()` - 14 edges

## Surprising Connections (you probably didn't know these)
- `Where things live` --references--> `main()`  [INFERRED]
  CLAUDE.md → data/build_gsu_dataset.py
- `Things that bit us (so they don't again)` --references--> `namesRestaurant()`  [INFERRED]
  CLAUDE.md → bot/src/dining.ts
- `Things that bit us (so they don't again)` --references--> `wantsPlan()`  [INFERRED]
  CLAUDE.md → bot/src/llm.ts
- `Things that bit us (so they don't again)` --references--> `wantsFood()`  [INFERRED]
  CLAUDE.md → bot/src/llm.ts
- `constraintsFor()` --calls--> `buildConstraints()`  [EXTRACTED]
  bot/src/dining.ts → src/pipeline/parse.ts

## Import Cycles
- None detected.

## Communities (37 total, 6 thin omitted)

### Community 0 - "dependencies"
Cohesion: 0.15
Nodes (13): dependencies, @aws-sdk/client-bedrock-runtime, @aws-sdk/client-dynamodb, @aws-sdk/client-lambda, @aws-sdk/client-polly, @aws-sdk/client-rds-data, @aws-sdk/client-secrets-manager, @aws-sdk/client-transcribe-streaming (+5 more)

### Community 1 - "day.ts"
Cohesion: 0.08
Nodes (37): space(), im, im, [to, text], cards, dayUrl(), fmt(), layout() (+29 more)

### Community 2 - "bot/package.json"
Cohesion: 0.13
Nodes (14): description, engines, node, @aws-sdk/client-bedrock-runtime, @aws-sdk/client-rds-data, tsx, @types/node, typescript (+6 more)

### Community 3 - "build_gsu_dataset.py"
Cohesion: 0.06
Nodes (23): health(), segment(), segment_route(), to_png(), add_nutrition(), allergens_from_text(), cached(), calories_from() (+15 more)

### Community 4 - "plan-demo.ts"
Cohesion: 0.15
Nodes (14): im, plan, [to, flag], votes, winner, cards, esc(), layout() (+6 more)

### Community 5 - "vision.ts"
Cohesion: 0.08
Nodes (27): { handle, tick }, people, planAnswers, planDeps, planPolls, polls, say(), scripts (+19 more)

### Community 6 - "scripts"
Cohesion: 0.22
Nodes (9): scripts, deploy, dev, send, sim, start, terminal, typecheck (+1 more)

### Community 7 - "compilerOptions"
Cohesion: 0.22
Nodes (8): compilerOptions, module, moduleResolution, noEmit, skipLibCheck, strict, target, include

### Community 8 - "plans.ts"
Cohesion: 0.06
Nodes (84): Origin, pickVaried(), Restrictions, unionRestrictions(), peekLocation(), cap(), COLORS, esc() (+76 more)

### Community 9 - "devDependencies"
Cohesion: 0.40
Nodes (5): devDependencies, esbuild, tsx, @types/node, typescript

### Community 11 - "dining.test.ts"
Cohesion: 0.10
Nodes (33): namesRestaurant(), chat(), client, historyKey(), loadHistory(), modelId(), NO_REPLY, planFollowup() (+25 more)

### Community 12 - "rag/store.ts"
Cohesion: 0.16
Nodes (21): buildRestaurantsSql(), buildSearchSql(), candidateFromRow(), db(), ensureSchema(), listRestaurants(), Param, pipeList() (+13 more)

### Community 13 - "parse.ts"
Cohesion: 0.08
Nodes (27): Case, cases, col(), CUISINE_RESTAURANTS, [header, ...body], only, raw, Row (+19 more)

### Community 14 - "voice.ts"
Cohesion: 0.14
Nodes (17): canConvertAudio(), convert(), hasFfmpeg(), pcmFromWav(), polly, POLLY_ENGINE, POLLY_VOICE, probeDuration() (+9 more)

### Community 15 - "package.json"
Cohesion: 0.08
Nodes (25): dependencies, @aws-sdk/client-bedrock-runtime, @aws-sdk/client-rds-data, description, devDependencies, tsx, @types/node, typescript (+17 more)

### Community 16 - "filter.ts"
Cohesion: 0.14
Nodes (20): ALLERGEN_KEYWORDS, CANONICAL_ALLERGENS, escapeRegex(), GLUTEN_FREE_CLAIM, keywordPatterns(), NormalizedAllergies, SYNONYMS, termsPattern() (+12 more)

### Community 17 - "CLAUDE.md"
Cohesion: 0.07
Nodes (25): Architecture, AWS Guidance for the new AWS experience, Commands, Constraints:, Context, Current state (read this first), Data: catalog CSV (one row per dish), DynamoDB tables (+17 more)

### Community 18 - "pipeline.test.ts"
Cohesion: 0.14
Nodes (18): RFC-4180, all, dishes, t0, texts, classifyKind(), dedupeDishes(), dishesFromCsv() (+10 more)

### Community 19 - "iMessage dining agent (bot)"
Cohesion: 0.11
Nodes (17): Architecture, iMessage dining agent (bot), Known limits, Layout, Run, Setup, What it does, Backend status (honest version) (+9 more)

### Community 20 - "lambda.ts"
Cohesion: 0.23
Nodes (12): Delivery, getBot(), handler(), Headers, lambda, processDelivery(), selfTest(), sleep() (+4 more)

### Community 21 - "recommend.ts"
Cohesion: 0.30
Nodes (13): Pick, DropReason, ParsedMessage, recommend(), Recommendation, retrievalKinds(), retrievalQuery(), Route (+5 more)

### Community 22 - "dining.ts"
Cohesion: 0.11
Nodes (34): askDirections(), chooseDish(), clearRestrictions(), composeDishMessage(), Destination, destKey(), directionsLink(), DishChoice (+26 more)

### Community 23 - "findmy.ts"
Cohesion: 0.20
Nodes (11): ASK_LINES, askedKey(), Fix, locate(), LocationResult, pick(), Read, requestLocation() (+3 more)

### Community 24 - "handler.ts"
Cohesion: 0.29
Nodes (16): getDay(), logMeal(), setGoals(), summary(), constraintsFor(), dishPoll(), restaurantNamed(), sendDm() (+8 more)

### Community 25 - "score.ts"
Cohesion: 0.33
Nodes (10): Goal, clamp01(), distanceScore(), goalFit(), MAX_WALK_KM, priceFit(), rankDishes(), SCORE_WEIGHTS (+2 more)

### Community 26 - "compilerOptions"
Cohesion: 0.18
Nodes (10): compilerOptions, module, moduleResolution, noEmit, noUncheckedIndexedAccess, skipLibCheck, strict, target (+2 more)

### Community 27 - "putState"
Cohesion: 0.24
Nodes (12): attentionKey(), escape(), isGroupChat(), mentionsBot(), shouldRespond(), reset(), claimOnce(), getState() (+4 more)

### Community 28 - "format.ts"
Cohesion: 0.60
Nodes (5): allergenConfidence, haversineKm(), appleMapsUrl(), formatReply(), hasAllergy()

### Community 34 - "invite.ts"
Cohesion: 0.33
Nodes (12): invite(), api(), auth(), base(), creds(), findUser(), inviteMessage(), listUsers() (+4 more)

### Community 35 - "polls.ts"
Cohesion: 0.23
Nodes (8): latestPollKey(), PollApi, pollKey(), PollKind, realPolls, send(), sleep(), wait()

### Community 36 - "embed.ts"
Cohesion: 0.60
Nodes (4): embed(), embedAll(), EMBEDDING_DIMENSIONS, requireEnv()

## Knowledge Gaps
- **13 isolated node(s):** `@aws-sdk/client-bedrock-runtime`, `@aws-sdk/client-rds-data`, `@types/node`, `esbuild`, `tsx` (+8 more)
  These have ≤1 connection - possible missing edges or undocumented components. (Counts symbols only; 275 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)
- **6 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `Current state (read this first)` connect `CLAUDE.md` to `dining.test.ts`?**
  _High betweenness centrality (0.190) - this node is a cross-community bridge._
- **Are the 4 inferred relationships involving `createHandler()` (e.g. with `sendDm()` and `sendDmImage()`) actually correct?**
  _`createHandler()` has 4 INFERRED edges - model-reasoned connections that need verification._
- **What connects `@aws-sdk/client-bedrock-runtime`, `@aws-sdk/client-rds-data`, `@types/node` to the rest of the system?**
  _13 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `day.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.08115942028985507 - nodes in this community are weakly interconnected._
- **Why does `Things that bit us (so they don't again)` connect `dining.test.ts` to `CLAUDE.md`?**
  _High betweenness centrality (0.186) - this node is a cross-community bridge._
- **Should `bot/package.json` be split into smaller, more focused modules?**
  _Cohesion score 0.13333333333333333 - nodes in this community are weakly interconnected._
- **Why does `Where things live` connect `CLAUDE.md` to `build_gsu_dataset.py`?**
  _High betweenness centrality (0.134) - this node is a cross-community bridge._