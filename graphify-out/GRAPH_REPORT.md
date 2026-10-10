# Graph Report - HackLanta-26  (2026-10-10)

## Corpus Check
- 89 files · ~114,415 words
- Verdict: corpus is large enough that graph structure adds value.
- Unclassified: 11 file(s) not represented in the graph (top: .ttf 3, .csv 3, .example 2)

## Summary
- 1010 nodes · 2442 edges · 53 communities (44 shown, 9 thin omitted)
- Extraction: 98% EXTRACTED · 2% INFERRED · 0% AMBIGUOUS · INFERRED: 45 edges (avg confidence: 0.87)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `49b7e528`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- dependencies
- day-art.ts
- bot/package.json
- build_gsu_dataset.py
- plan-demo.ts
- vision.ts
- scripts
- compilerOptions
- plans.ts
- devDependencies
- vision-server
- llm.ts
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
- dining.ts
- findmy.ts
- day.ts
- score.ts
- compilerOptions
- dining.test.ts
- format.ts
- deploy-lambda.sh
- build-ffmpeg-layer.sh
- vision-server/README.md
- graphify
- .mcp.json
- invite.ts
- putState
- gsap.min.js
- health.ts
- Brag Plan: Snacxx, the iMessage dining agent ("Stop planning. Start eating.")
- r
- web.ts
- Tween
- explain.ts
- users.ts
- _d
- ja
- health-demo.ts
- health-sim.ts
- cb
- xe
- Ub
- Vb
- credits.md

## God Nodes (most connected - your core abstractions)
1. `createHandler()` - 65 edges
2. `handle()` - 54 edges
3. `putState()` - 40 edges
4. `startPlan()` - 27 edges
5. `realPlanDeps()` - 22 edges
6. `advance()` - 21 edges
7. `handleHealthRequest()` - 18 edges
8. `restaurantDishes()` - 17 edges
9. `stageTime()` - 17 edges
10. `stagePlace()` - 17 edges

## Surprising Connections (you probably didn't know these)
- `Data: catalog CSV (one row per dish)` --references--> `phone()`  [INFERRED]
  CLAUDE.md → bot/scripts/health-sim.ts
- `DynamoDB tables` --references--> `phone()`  [INFERRED]
  CLAUDE.md → bot/scripts/health-sim.ts
- `Key moments (the middle)` --references--> `dayJpeg()`  [INFERRED]
  brag-output/brag-plan.md → bot/src/day-art.ts
- `Source Material` --references--> `dayJpeg()`  [INFERRED]
  brag-output/composition-brief.md → bot/src/day-art.ts
- `Key moments (the middle)` --references--> `meetupJpeg()`  [INFERRED]
  brag-output/brag-plan.md → bot/src/meetup-card.ts

## Import Cycles
- None detected.

## Communities (53 total, 9 thin omitted)

### Community 0 - "dependencies"
Cohesion: 0.15
Nodes (13): dependencies, @aws-sdk/client-bedrock-runtime, @aws-sdk/client-dynamodb, @aws-sdk/client-lambda, @aws-sdk/client-polly, @aws-sdk/client-rds-data, @aws-sdk/client-secrets-manager, @aws-sdk/client-transcribe-streaming (+5 more)

### Community 1 - "day-art.ts"
Cohesion: 0.17
Nodes (18): cards, dayUrl(), fmt(), layout(), sendDayCard(), BASIL, CRUMBS, dayJpeg() (+10 more)

### Community 2 - "bot/package.json"
Cohesion: 0.12
Nodes (15): description, engines, node, @aws-sdk/client-bedrock-runtime, @aws-sdk/client-rds-data, tsx, @types/node, typescript (+7 more)

### Community 3 - "build_gsu_dataset.py"
Cohesion: 0.05
Nodes (27): health(), segment(), segment_route(), to_png(), add_nutrition(), allergens_from_text(), cached(), calories_from() (+19 more)

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
Cohesion: 0.05
Nodes (109): publishCard(), Origin, Restrictions, restrictionsFor(), unionRestrictions(), peekLocation(), MeetupCard, ackFor() (+101 more)

### Community 9 - "devDependencies"
Cohesion: 0.40
Nodes (5): devDependencies, esbuild, tsx, @types/node, typescript

### Community 11 - "llm.ts"
Cohesion: 0.22
Nodes (18): namesRestaurant(), chat(), client, historyKey(), loadHistory(), modelId(), planFollowup(), remember() (+10 more)

### Community 12 - "rag/store.ts"
Cohesion: 0.11
Nodes (29): all, dishes, t0, texts, embed(), embedAll(), EMBEDDING_DIMENSIONS, requireEnv() (+21 more)

### Community 13 - "parse.ts"
Cohesion: 0.08
Nodes (26): Case, cases, col(), CUISINE_RESTAURANTS, [header, ...body], MEATS, only, raw (+18 more)

### Community 14 - "handler.ts"
Cohesion: 0.09
Nodes (41): setGoals(), summary(), constraintsFor(), directionsLink(), dishPoll(), restaurantNamed(), restaurantPoll(), openDm() (+33 more)

### Community 15 - "package.json"
Cohesion: 0.08
Nodes (25): dependencies, @aws-sdk/client-bedrock-runtime, @aws-sdk/client-rds-data, description, devDependencies, tsx, @types/node, typescript (+17 more)

### Community 16 - "filter.ts"
Cohesion: 0.14
Nodes (25): ALLERGEN_KEYWORDS, CANONICAL_ALLERGENS, escapeRegex(), GLUTEN_FREE_CLAIM, hasRealAllergy(), isRealAllergen(), keywordPatterns(), MEAT_AVOIDANCES (+17 more)

### Community 17 - "CLAUDE.md"
Cohesion: 0.08
Nodes (24): Apple Health sync, Architecture, AWS Guidance for the new AWS experience, Commands, Constraints:, Context, Current state (read this first), Environment / secrets (+16 more)

### Community 18 - "pipeline.test.ts"
Cohesion: 0.20
Nodes (13): RFC-4180, classifyKind(), dedupeDishes(), dishesFromCsv(), loadCatalog(), num(), parseCsv(), cuisinesFor() (+5 more)

### Community 19 - "iMessage dining agent (bot)"
Cohesion: 0.10
Nodes (19): Apple Health sync, Architecture, iMessage dining agent (bot), Known limits, Layout, Run, Setup, What it does (+11 more)

### Community 20 - "lambda.ts"
Cohesion: 0.08
Nodes (34): isCardToken(), loadCard(), rememberBaseUrl(), CONNECTED_TEXT, cardRoute(), Delivery, getBot(), handler() (+26 more)

### Community 21 - "recommend.ts"
Cohesion: 0.27
Nodes (14): Pick, pickDishes(), DropReason, ParsedMessage, recommend(), Recommendation, retrievalKinds(), retrievalQuery() (+6 more)

### Community 22 - "dining.ts"
Cohesion: 0.09
Nodes (38): askDirections(), askedKey(), chooseDish(), composeDishMessage(), Destination, destKey(), directionsAnswer(), DishChoice (+30 more)

### Community 23 - "findmy.ts"
Cohesion: 0.20
Nodes (11): ASK_LINES, askedKey(), Fix, locate(), LocationResult, pick(), Read, requestLocation() (+3 more)

### Community 24 - "day.ts"
Cohesion: 0.23
Nodes (16): im, budgetLeft(), DEFAULT_GOALS, finite(), freshDay(), getDay(), getDayByKey(), keyFor() (+8 more)

### Community 25 - "score.ts"
Cohesion: 0.33
Nodes (10): Goal, clamp01(), distanceScore(), goalFit(), MAX_WALK_KM, priceFit(), rankDishes(), SCORE_WEIGHTS (+2 more)

### Community 26 - "compilerOptions"
Cohesion: 0.18
Nodes (10): compilerOptions, module, moduleResolution, noEmit, noUncheckedIndexedAccess, skipLibCheck, strict, target (+2 more)

### Community 27 - "dining.test.ts"
Cohesion: 0.26
Nodes (9): attentionKey(), botNames(), escape(), isGroupChat(), mentionsBot(), shouldRespond(), SAFETY_CLAIM, none (+1 more)

### Community 28 - "format.ts"
Cohesion: 0.60
Nodes (5): allergenConfidence, haversineKm(), appleMapsUrl(), formatReply(), hasAllergy()

### Community 34 - "invite.ts"
Cohesion: 0.33
Nodes (12): invite(), api(), auth(), base(), creds(), findUser(), inviteMessage(), listUsers() (+4 more)

### Community 35 - "putState"
Cohesion: 0.14
Nodes (14): clearRestrictions(), mergeRestrictions(), norm(), profileKey(), PollApi, PollKind, realPolls, sleep() (+6 more)

### Community 36 - "gsap.min.js"
Cohesion: 0.06
Nodes (17): Ec(), ee(), Fc(), Jd(), Kd(), la(), Ld(), ma() (+9 more)

### Community 37 - "health.ts"
Cohesion: 0.10
Nodes (31): baseUrl(), Goals, ackMeals(), connectHealth(), connectText(), esc(), fromHealthAutoExport(), getMetrics() (+23 more)

### Community 38 - "Brag Plan: Snacxx, the iMessage dining agent ("Stop planning. Start eating.")"
Cohesion: 0.07
Nodes (26): Audio direction, Brag Plan: Snacxx, the iMessage dining agent ("Stop planning. Start eating."), Duration: 50 s, Format: landscape — 1920x1080, Hook (first 3 s), Key moments (the middle), Outro / punchline, Scene 10: Built on Photon — 43.0-47.0 s (+18 more)

### Community 39 - "r"
Cohesion: 0.15
Nodes (20): _a(), ac(), Co(), db(), ea(), eb(), ga(), gb() (+12 more)

### Community 40 - "web.ts"
Cohesion: 0.17
Nodes (12): im, [to, text], healthReply(), isHealthPath(), { handle, tick }, options, esc(), page() (+4 more)

### Community 41 - "Tween"
Cohesion: 0.18
Nodes (15): _assertThisInitialized(), gc(), ka(), qa(), t(), tb(), Timeline(), Tween() (+7 more)

### Community 42 - "explain.ts"
Cohesion: 0.26
Nodes (9): converseTool(), CASUAL_SCHEMA, cleanCasualName(), cleanReason(), fallbackReason(), RawPicks, SCHEMA, tokens() (+1 more)

### Community 43 - "users.ts"
Cohesion: 0.27
Nodes (6): getUser(), listProfiles(), normalizePhone(), strings(), UserProfile, @aws-sdk/client-dynamodb

### Community 44 - "_d"
Cohesion: 0.29
Nodes (10): be(), _d(), fa(), ia(), ie(), je(), ke(), le() (+2 more)

### Community 45 - "ja"
Cohesion: 0.28
Nodes (9): Aa(), Animation(), ha(), ja(), Jc(), Lc(), Ra(), Sa() (+1 more)

### Community 46 - "health-demo.ts"
Cohesion: 0.29
Nodes (6): lan, logNext(), samples, adjustedCalories(), dayGoals(), healthSummary()

### Community 47 - "health-sim.ts"
Cohesion: 0.25
Nodes (7): { handle }, phone(), say(), space, setPublicBase(), Data: catalog CSV (one row per dish), DynamoDB tables

### Community 48 - "cb"
Cohesion: 0.29
Nodes (7): Ab(), Bb(), cb(), Context(), fb(), Gw(), zb()

### Community 49 - "xe"
Cohesion: 0.50
Nodes (4): Ud(), vd(), we(), xe()

## Knowledge Gaps
- **13 isolated node(s):** `@aws-sdk/client-bedrock-runtime`, `@aws-sdk/client-rds-data`, `@types/node`, `esbuild`, `tsx` (+8 more)
  These have ≤1 connection - possible missing edges or undocumented components. (Counts symbols only; 356 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)
- **9 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `t()` connect `Tween` to `cb`, `plans.ts`, `gsap.min.js`, `r`?**
  _High betweenness centrality (0.090) - this node is a cross-community bridge._
- **Are the 6 inferred relationships involving `createHandler()` (e.g. with `openDm()` and `sendDm()`) actually correct?**
  _`createHandler()` has 6 INFERRED edges - model-reasoned connections that need verification._
- **What connects `@aws-sdk/client-bedrock-runtime`, `@aws-sdk/client-rds-data`, `@types/node` to the rest of the system?**
  _13 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `bot/package.json` be split into smaller, more focused modules?**
  _Cohesion score 0.125 - nodes in this community are weakly interconnected._
- **Why does `x()` connect `Tween` to `plans.ts`, `gsap.min.js`?**
  _High betweenness centrality (0.063) - this node is a cross-community bridge._
- **Are the 3 inferred relationships involving `realPlanDeps()` (e.g. with `peekLocation()` and `requestLocation()`) actually correct?**
  _`realPlanDeps()` has 3 INFERRED edges - model-reasoned connections that need verification._
- **Should `build_gsu_dataset.py` be split into smaller, more focused modules?**
  _Cohesion score 0.05454545454545454 - nodes in this community are weakly interconnected._