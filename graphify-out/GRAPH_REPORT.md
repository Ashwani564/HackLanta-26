# Graph Report - HackLanta-26  (2026-10-10)

## Corpus Check
- cluster-only mode — file stats not available

## Summary
- 181 nodes · 302 edges · 11 communities (9 shown, 2 thin omitted)
- Extraction: 100% EXTRACTED · 0% INFERRED · 0% AMBIGUOUS · INFERRED: 1 edges (avg confidence: 0.85)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `d29a975c`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- Community 0
- Community 1
- Community 2
- Community 3
- Community 4
- Community 5
- Community 6
- Community 7
- Community 8
- Community 9
- Community 10

## God Nodes (most connected - your core abstractions)
1. `handle()` - 16 edges
2. `annotateFood()` - 9 edges
3. `getDay()` - 7 edges
4. `totals()` - 7 edges
5. `speak()` - 7 edges
6. `spectrum-ts` - 7 edges
7. `compilerOptions` - 7 edges
8. `scripts` - 7 edges
9. `invite()` - 6 edges
10. `ringsJpeg()` - 6 edges

## Surprising Connections (you probably didn't know these)
- `handle()` --calls--> `sendDayCard()`  [EXTRACTED]
  bot/src/index.ts → bot/src/card.ts
- `handle()` --calls--> `getDay()`  [EXTRACTED]
  bot/src/index.ts → bot/src/day.ts
- `handle()` --calls--> `logMeal()`  [EXTRACTED]
  bot/src/index.ts → bot/src/day.ts
- `handle()` --calls--> `setGoals()`  [EXTRACTED]
  bot/src/index.ts → bot/src/day.ts
- `handle()` --calls--> `annotateFood()`  [EXTRACTED]
  bot/src/index.ts → bot/src/vision.ts

## Import Cycles
- None detected.

## Communities (11 total, 2 thin omitted)

### Community 0 - "Community 0"
Cohesion: 0.13
Nodes (29): summary(), locate(), ai, chat(), generate(), histories, MODELS, PHOTO_PROMPT (+21 more)

### Community 1 - "Community 1"
Cohesion: 0.12
Nodes (25): im, cards, dayUrl(), fmt(), layout(), RINGS, ringsJpeg(), sendDayCard() (+17 more)

### Community 2 - "Community 2"
Cohesion: 0.07
Nodes (24): dependencies, @elevenlabs/elevenlabs-js, @google/genai, @photon-ai/advanced-imessage, sharp, spectrum-ts, description, devDependencies (+16 more)

### Community 3 - "Community 3"
Cohesion: 0.11
Nodes (4): health(), segment(), segment_route(), to_png()

### Community 4 - "Community 4"
Cohesion: 0.15
Nodes (14): im, plan, [to, flag], votes, winner, cards, esc(), layout() (+6 more)

### Community 5 - "Community 5"
Cohesion: 0.21
Nodes (15): ai, annotateFood(), COLORS, detect(), esc(), FoodItem, HEDGES, hex() (+7 more)

### Community 6 - "Community 6"
Cohesion: 0.21
Nodes (8): ai, geminiTTS(), probeDuration(), run, speak(), TTS_MODELS, wav(), @elevenlabs/elevenlabs-js

### Community 7 - "Community 7"
Cohesion: 0.22
Nodes (8): compilerOptions, module, moduleResolution, noEmit, skipLibCheck, strict, target, include

### Community 8 - "Community 8"
Cohesion: 0.29
Nodes (7): scripts, dev, send, start, terminal, typecheck, vision

## Knowledge Gaps
- **4 isolated node(s):** `vision-server`, `tsx`, `@types/node`, `typescript`
  These have ≤1 connection - possible missing edges. (Counts symbols only; 82 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)
- **2 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `spectrum-ts` connect `Community 1` to `Community 0`, `Community 9`, `Community 2`, `Community 4`?**
  _High betweenness centrality (0.184) - this node is a cross-community bridge._
- **What connects `vision-server`, `tsx`, `@types/node` to the rest of the system?**
  _4 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Community 0` be split into smaller, more focused modules?**
  _Cohesion score 0.12903225806451613 - nodes in this community are weakly interconnected._
- **Why does `sharp` connect `Community 4` to `Community 1`, `Community 2`, `Community 5`?**
  _High betweenness centrality (0.056) - this node is a cross-community bridge._
- **Should `Community 1` be split into smaller, more focused modules?**
  _Cohesion score 0.12043010752688173 - nodes in this community are weakly interconnected._
- **Why does `@google/genai` connect `Community 2` to `Community 0`, `Community 5`, `Community 6`?**
  _High betweenness centrality (0.053) - this node is a cross-community bridge._
- **Should `Community 2` be split into smaller, more focused modules?**
  _Cohesion score 0.07407407407407407 - nodes in this community are weakly interconnected._