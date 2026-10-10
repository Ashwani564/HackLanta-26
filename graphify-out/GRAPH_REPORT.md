# Graph Report - HackLanta-26  (2026-10-10)

## Corpus Check
- cluster-only mode — file stats not available

## Summary
- 692 nodes · 1571 edges · 34 communities (27 shown, 7 thin omitted)
- Extraction: 99% EXTRACTED · 1% INFERRED · 0% AMBIGUOUS · INFERRED: 14 edges (avg confidence: 0.85)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `14c07571`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- invite.ts
- day-art.ts
- bot/package.json
- build_gsu_dataset.py
- plan-demo.ts
- vision.ts
- voice.ts
- compilerOptions
- plans.ts
- send.ts
- vision-server
- dining.ts
- rag/store.ts
- parse.ts
- handler.ts
- package.json
- filter.ts
- CLAUDE.md
- pipeline.test.ts
- iMessage dining agent (bot)
- lambda.ts
- recommend.ts
- day.ts
- findmy.ts
- explain.ts
- score.ts
- compilerOptions
- addressing.ts
- format.ts
- deploy-lambda.sh
- build-ffmpeg-layer.sh
- vision-server/README.md
- graphify
- .mcp.json

## God Nodes (most connected - your core abstractions)
1. `createHandler()` - 51 edges
2. `handle()` - 43 edges
3. `putState()` - 28 edges
4. `startPlan()` - 19 edges
5. `restaurantDishes()` - 17 edges
6. `chat()` - 14 edges
7. `advance()` - 14 edges
8. `stagePlace()` - 14 edges
9. `handleReply()` - 13 edges
10. `Candidate` - 12 edges

## Surprising Connections (you probably didn't know these)
- `composeDishMessage()` --calls--> `allergenConfidence`  [EXTRACTED]
  bot/src/dining.ts → src/pipeline/allergens.ts
- `resolveRestaurant()` --calls--> `listRestaurants()`  [EXTRACTED]
  bot/src/dining.ts → src/rag/store.ts
- `restaurantDishes()` --calls--> `pickDishes()`  [EXTRACTED]
  bot/src/dining.ts → src/pipeline/explain.ts
- `restaurantDishes()` --calls--> `parseMessage()`  [EXTRACTED]
  bot/src/dining.ts → src/pipeline/parse.ts
- `restaurantDishes()` --calls--> `rankDishes()`  [EXTRACTED]
  bot/src/dining.ts → src/pipeline/score.ts

## Import Cycles
- None detected.

## Communities (34 total, 7 thin omitted)

### Community 0 - "invite.ts"
Cohesion: 0.44
Nodes (9): api(), auth(), base(), creds(), findUser(), listUsers(), PhotonUser, registerUser() (+1 more)

### Community 1 - "day-art.ts"
Cohesion: 0.12
Nodes (26): space(), cards, dayUrl(), fmt(), layout(), sendDayCard(), BASIL, CRUMBS (+18 more)

### Community 2 - "bot/package.json"
Cohesion: 0.05
Nodes (42): dependencies, @aws-sdk/client-bedrock-runtime, @aws-sdk/client-dynamodb, @aws-sdk/client-lambda, @aws-sdk/client-polly, @aws-sdk/client-rds-data, @aws-sdk/client-secrets-manager, @aws-sdk/client-transcribe-streaming (+34 more)

### Community 3 - "build_gsu_dataset.py"
Cohesion: 0.06
Nodes (23): health(), segment(), segment_route(), to_png(), add_nutrition(), allergens_from_text(), cached(), calories_from() (+15 more)

### Community 4 - "plan-demo.ts"
Cohesion: 0.15
Nodes (14): im, plan, [to, flag], votes, winner, cards, esc(), layout() (+6 more)

### Community 5 - "vision.ts"
Cohesion: 0.09
Nodes (27): { handle, tick }, people, planAnswers, planDeps, planPolls, polls, say(), scripts (+19 more)

### Community 6 - "voice.ts"
Cohesion: 0.14
Nodes (17): canConvertAudio(), convert(), hasFfmpeg(), pcmFromWav(), polly, POLLY_ENGINE, POLLY_VOICE, probeDuration() (+9 more)

### Community 7 - "compilerOptions"
Cohesion: 0.22
Nodes (8): compilerOptions, module, moduleResolution, noEmit, skipLibCheck, strict, target, include

### Community 8 - "plans.ts"
Cohesion: 0.06
Nodes (74): Origin, pickVaried(), Restrictions, unionRestrictions(), activeIds(), advance(), announce(), Ask (+66 more)

### Community 11 - "dining.ts"
Cohesion: 0.07
Nodes (47): composeDishMessage(), Destination, destKey(), DishChoice, dishesKey(), EMPTY_PARSE, hasAllergy(), namesRestaurant() (+39 more)

### Community 12 - "rag/store.ts"
Cohesion: 0.11
Nodes (29): all, dishes, t0, texts, embed(), embedAll(), EMBEDDING_DIMENSIONS, requireEnv() (+21 more)

### Community 13 - "parse.ts"
Cohesion: 0.08
Nodes (27): Case, cases, col(), CUISINE_RESTAURANTS, [header, ...body], only, raw, Row (+19 more)

### Community 14 - "handler.ts"
Cohesion: 0.19
Nodes (26): askDirections(), chooseDish(), clearRestrictions(), constraintsFor(), directionsLink(), dishPoll(), mergeRestrictions(), nearbyRestaurants() (+18 more)

### Community 15 - "package.json"
Cohesion: 0.08
Nodes (25): dependencies, @aws-sdk/client-bedrock-runtime, @aws-sdk/client-rds-data, description, devDependencies, tsx, @types/node, typescript (+17 more)

### Community 16 - "filter.ts"
Cohesion: 0.14
Nodes (19): ALLERGEN_KEYWORDS, CANONICAL_ALLERGENS, escapeRegex(), GLUTEN_FREE_CLAIM, keywordPatterns(), NormalizedAllergies, SYNONYMS, termsPattern() (+11 more)

### Community 17 - "CLAUDE.md"
Cohesion: 0.10
Nodes (19): Architecture, AWS Guidance for the new AWS experience, Constraints:, Context, Data: catalog CSV (one row per dish), DynamoDB tables, Environment / secrets, graphify (+11 more)

### Community 18 - "pipeline.test.ts"
Cohesion: 0.18
Nodes (14): RFC-4180, classifyKind(), dedupeDishes(), dishesFromCsv(), loadCatalog(), num(), parseCsv(), CUISINE_BY_RESTAURANT (+6 more)

### Community 19 - "iMessage dining agent (bot)"
Cohesion: 0.11
Nodes (17): Architecture, iMessage dining agent (bot), Known limits, Layout, Run, Setup, What it does, Backend status (honest version) (+9 more)

### Community 20 - "lambda.ts"
Cohesion: 0.20
Nodes (13): Delivery, getBot(), handler(), Headers, lambda, processDelivery(), selfTest(), sleep() (+5 more)

### Community 21 - "recommend.ts"
Cohesion: 0.30
Nodes (13): Pick, DropReason, ParsedMessage, recommend(), Recommendation, retrievalKinds(), retrievalQuery(), Route (+5 more)

### Community 22 - "day.ts"
Cohesion: 0.23
Nodes (12): im, DEFAULT_GOALS, freshDay(), getDay(), getDayByKey(), Goals, keyFor(), logMeal() (+4 more)

### Community 23 - "findmy.ts"
Cohesion: 0.21
Nodes (10): ASK_LINES, askedKey(), Fix, locate(), LocationResult, pick(), Read, sleep() (+2 more)

### Community 24 - "explain.ts"
Cohesion: 0.24
Nodes (10): converseTool(), CASUAL_SCHEMA, cleanCasualName(), cleanReason(), fallbackReason(), pickDishes(), RawPicks, SCHEMA (+2 more)

### Community 25 - "score.ts"
Cohesion: 0.33
Nodes (10): Goal, clamp01(), distanceScore(), goalFit(), MAX_WALK_KM, priceFit(), rankDishes(), SCORE_WEIGHTS (+2 more)

### Community 26 - "compilerOptions"
Cohesion: 0.18
Nodes (10): compilerOptions, module, moduleResolution, noEmit, noUncheckedIndexedAccess, skipLibCheck, strict, target (+2 more)

### Community 27 - "addressing.ts"
Cohesion: 0.48
Nodes (5): attentionKey(), escape(), isGroupChat(), mentionsBot(), shouldRespond()

### Community 28 - "format.ts"
Cohesion: 0.60
Nodes (5): allergenConfidence, haversineKm(), appleMapsUrl(), formatReply(), hasAllergy()

## Knowledge Gaps
- **13 isolated node(s):** `vision-server`, `@aws-sdk/client-bedrock-runtime`, `@aws-sdk/client-rds-data`, `tsx`, `@types/node` (+8 more)
  These have ≤1 connection - possible missing edges or undocumented components. (Counts symbols only; 266 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)
- **7 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `spectrum-ts` connect `handler.ts` to `day-art.ts`, `bot/package.json`, `plan-demo.ts`, `send.ts`, `lambda.ts`, `day.ts`?**
  _High betweenness centrality (0.079) - this node is a cross-community bridge._
- **Are the 3 inferred relationships involving `createHandler()` (e.g. with `sendDm()` and `handle()`) actually correct?**
  _`createHandler()` has 3 INFERRED edges - model-reasoned connections that need verification._
- **What connects `vision-server`, `@aws-sdk/client-bedrock-runtime`, `@aws-sdk/client-rds-data` to the rest of the system?**
  _13 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `day-art.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.12043010752688173 - nodes in this community are weakly interconnected._
- **Should `bot/package.json` be split into smaller, more focused modules?**
  _Cohesion score 0.046511627906976744 - nodes in this community are weakly interconnected._
- **Should `build_gsu_dataset.py` be split into smaller, more focused modules?**
  _Cohesion score 0.05706214689265537 - nodes in this community are weakly interconnected._
- **Should `vision.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.09032258064516129 - nodes in this community are weakly interconnected._