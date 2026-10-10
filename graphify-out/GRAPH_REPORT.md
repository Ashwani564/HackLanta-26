# Graph Report - HackLanta-26  (2026-10-10)

## Corpus Check
- 74 files · ~62,342 words
- Verdict: corpus is large enough that graph structure adds value.
- Unclassified: 8 file(s) not represented in the graph (top: .csv 3, .example 2, (none) 2)

## Summary
- 700 nodes · 1587 edges · 32 communities (26 shown, 6 thin omitted)
- Extraction: 99% EXTRACTED · 1% INFERRED · 0% AMBIGUOUS · INFERRED: 18 edges (avg confidence: 0.87)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `878299df`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- dependencies
- day.ts
- bot/package.json
- build_gsu_dataset.py
- plan-demo.ts
- chat-sim.mts
- scripts
- compilerOptions
- plans.ts
- devDependencies
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
- findmy.ts
- explain.ts
- score.ts
- compilerOptions
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
6. `chat()` - 15 edges
7. `stagePlace()` - 14 edges
8. `advance()` - 14 edges
9. `handleReply()` - 13 edges
10. `PlanDeps` - 12 edges

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

## Communities (32 total, 6 thin omitted)

### Community 0 - "dependencies"
Cohesion: 0.15
Nodes (13): dependencies, @aws-sdk/client-bedrock-runtime, @aws-sdk/client-dynamodb, @aws-sdk/client-lambda, @aws-sdk/client-polly, @aws-sdk/client-rds-data, @aws-sdk/client-secrets-manager, @aws-sdk/client-transcribe-streaming (+5 more)

### Community 1 - "day.ts"
Cohesion: 0.10
Nodes (32): space(), cards, dayUrl(), fmt(), layout(), BASIL, CRUMBS, dayJpeg() (+24 more)

### Community 2 - "bot/package.json"
Cohesion: 0.13
Nodes (14): description, engines, node, @aws-sdk/client-bedrock-runtime, @aws-sdk/client-rds-data, tsx, @types/node, typescript (+6 more)

### Community 3 - "build_gsu_dataset.py"
Cohesion: 0.06
Nodes (23): health(), segment(), segment_route(), to_png(), add_nutrition(), allergens_from_text(), cached(), calories_from() (+15 more)

### Community 4 - "plan-demo.ts"
Cohesion: 0.15
Nodes (14): im, plan, [to, flag], votes, winner, cards, esc(), layout() (+6 more)

### Community 5 - "chat-sim.mts"
Cohesion: 0.18
Nodes (10): { handle, tick }, people, planAnswers, planDeps, planPolls, polls, say(), scripts (+2 more)

### Community 6 - "scripts"
Cohesion: 0.22
Nodes (9): scripts, deploy, dev, send, sim, start, terminal, typecheck (+1 more)

### Community 7 - "compilerOptions"
Cohesion: 0.22
Nodes (8): compilerOptions, module, moduleResolution, noEmit, skipLibCheck, strict, target, include

### Community 8 - "plans.ts"
Cohesion: 0.06
Nodes (75): Origin, pickVaried(), Restrictions, unionRestrictions(), activeIds(), advance(), announce(), Ask (+67 more)

### Community 9 - "devDependencies"
Cohesion: 0.40
Nodes (5): devDependencies, esbuild, tsx, @types/node, typescript

### Community 11 - "dining.ts"
Cohesion: 0.07
Nodes (47): composeDishMessage(), Destination, destKey(), DishChoice, dishesKey(), EMPTY_PARSE, hasAllergy(), namesRestaurant() (+39 more)

### Community 12 - "rag/store.ts"
Cohesion: 0.11
Nodes (30): all, dishes, t0, texts, embed(), embedAll(), EMBEDDING_DIMENSIONS, requireEnv() (+22 more)

### Community 13 - "parse.ts"
Cohesion: 0.08
Nodes (27): Case, cases, col(), CUISINE_RESTAURANTS, [header, ...body], only, raw, Row (+19 more)

### Community 14 - "handler.ts"
Cohesion: 0.05
Nodes (84): im, im, [to, text], attentionKey(), escape(), isGroupChat(), mentionsBot(), shouldRespond() (+76 more)

### Community 15 - "package.json"
Cohesion: 0.08
Nodes (25): dependencies, @aws-sdk/client-bedrock-runtime, @aws-sdk/client-rds-data, description, devDependencies, tsx, @types/node, typescript (+17 more)

### Community 16 - "filter.ts"
Cohesion: 0.14
Nodes (19): ALLERGEN_KEYWORDS, CANONICAL_ALLERGENS, escapeRegex(), GLUTEN_FREE_CLAIM, keywordPatterns(), NormalizedAllergies, SYNONYMS, termsPattern() (+11 more)

### Community 17 - "CLAUDE.md"
Cohesion: 0.07
Nodes (25): Architecture, AWS Guidance for the new AWS experience, Commands, Constraints:, Context, Current state (read this first), Data: catalog CSV (one row per dish), DynamoDB tables (+17 more)

### Community 18 - "pipeline.test.ts"
Cohesion: 0.18
Nodes (14): RFC-4180, classifyKind(), dedupeDishes(), dishesFromCsv(), loadCatalog(), num(), parseCsv(), CUISINE_BY_RESTAURANT (+6 more)

### Community 19 - "iMessage dining agent (bot)"
Cohesion: 0.11
Nodes (17): Architecture, iMessage dining agent (bot), Known limits, Layout, Run, Setup, What it does, Backend status (honest version) (+9 more)

### Community 20 - "lambda.ts"
Cohesion: 0.23
Nodes (12): Delivery, getBot(), handler(), Headers, lambda, processDelivery(), selfTest(), sleep() (+4 more)

### Community 21 - "recommend.ts"
Cohesion: 0.28
Nodes (14): Pick, pickDishes(), DropReason, ParsedMessage, recommend(), Recommendation, retrievalKinds(), retrievalQuery() (+6 more)

### Community 23 - "findmy.ts"
Cohesion: 0.21
Nodes (10): ASK_LINES, askedKey(), Fix, locate(), LocationResult, pick(), Read, sleep() (+2 more)

### Community 24 - "explain.ts"
Cohesion: 0.26
Nodes (9): converseTool(), CASUAL_SCHEMA, cleanCasualName(), cleanReason(), fallbackReason(), RawPicks, SCHEMA, tokens() (+1 more)

### Community 25 - "score.ts"
Cohesion: 0.33
Nodes (10): Goal, clamp01(), distanceScore(), goalFit(), MAX_WALK_KM, priceFit(), rankDishes(), SCORE_WEIGHTS (+2 more)

### Community 26 - "compilerOptions"
Cohesion: 0.18
Nodes (10): compilerOptions, module, moduleResolution, noEmit, noUncheckedIndexedAccess, skipLibCheck, strict, target (+2 more)

### Community 28 - "format.ts"
Cohesion: 0.60
Nodes (5): allergenConfidence, haversineKm(), appleMapsUrl(), formatReply(), hasAllergy()

## Knowledge Gaps
- **13 isolated node(s):** `@aws-sdk/client-bedrock-runtime`, `@aws-sdk/client-rds-data`, `@types/node`, `esbuild`, `tsx` (+8 more)
  These have ≤1 connection - possible missing edges or undocumented components. (Counts symbols only; 270 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)
- **6 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `Current state (read this first)` connect `CLAUDE.md` to `dining.ts`?**
  _High betweenness centrality (0.196) - this node is a cross-community bridge._
- **Are the 3 inferred relationships involving `createHandler()` (e.g. with `sendDm()` and `handle()`) actually correct?**
  _`createHandler()` has 3 INFERRED edges - model-reasoned connections that need verification._
- **What connects `@aws-sdk/client-bedrock-runtime`, `@aws-sdk/client-rds-data`, `@types/node` to the rest of the system?**
  _13 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `day.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.09581646423751687 - nodes in this community are weakly interconnected._
- **Why does `Things that bit us (so they don't again)` connect `dining.ts` to `CLAUDE.md`?**
  _High betweenness centrality (0.191) - this node is a cross-community bridge._
- **Should `bot/package.json` be split into smaller, more focused modules?**
  _Cohesion score 0.13333333333333333 - nodes in this community are weakly interconnected._
- **Why does `Where things live` connect `CLAUDE.md` to `build_gsu_dataset.py`?**
  _High betweenness centrality (0.138) - this node is a cross-community bridge._