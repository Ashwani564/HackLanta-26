/**
 * Live eval: messy texts -> LLM parse -> constraints -> pgvector retrieval -> pick -> reply.
 * Pass bar: ZERO allergen leaks. Every returned dish is re-checked against the raw CSV with logic that
 * does not share code with src/pipeline/filter.ts, so a bug there cannot hide itself.
 *
 *   npm run eval            # all cases
 *   npm run eval -- group-merge peanut-thai
 */
import { readFileSync } from "node:fs";
import { parseCsv } from "../src/data/catalog.js";
import { buildConstraints, parseMessage } from "../src/pipeline/parse.js";
import { routeMessage } from "../src/pipeline/route.js";
import { recommend } from "../src/pipeline/recommend.js";

interface Case {
  id: string;
  text: string;
  profile?: { allergies?: string[]; diets?: string[]; budgetMaxUsd?: number };
  /** Canonical allergens that must not appear in anything returned. Written by hand, not derived from the parse. */
  mustAvoid: string[];
  /** Allergy words that are not in the canonical list (coconut, kiwi). Blank-allergen dishes also count as leaks. */
  mustAvoidText?: string[];
  /** Foods or cuisines that must not appear (not an allergy, so blank allergens are fine). */
  mustExclude?: string[];
  /** Where the message should route. Defaults to recommend so a misroute cannot pass vacuously. */
  expectRoute?: "recommend" | "update_profile";
  mustDiet?: string[];
  budget?: number;
  allowEmpty?: boolean;
  group?: boolean;
}

const cases: Case[] = JSON.parse(readFileSync("tests/eval/cases.json", "utf8"));
const only = process.argv.slice(2);
const selected = only.length > 0 ? cases.filter((c) => only.includes(c.id)) : cases;

// Ground truth read straight from the CSV cells. Deliberately does NOT use loadCatalog, parseCatalogAllergens or
// ALLERGEN_KEYWORDS, so a bug or an omission in src/ cannot hide itself here.
interface Row { id: string; name: string; description: string; category: string; restaurant: string; cuisine: string; allergenCell: string; allergens: string[]; diet: string[]; price: number | null }
const [header, ...body] = parseCsv(readFileSync(process.env.CATALOG_CSV ?? "data/gsu_dishes.csv", "utf8"));
const col = (name: string) => header!.indexOf(name);
const raw = new Map<string, Row>(
  body.map((r) => {
    const cell = (r[col("allergens")] ?? "").trim().toLowerCase();
    const price = (r[col("price_usd")] ?? "").trim();
    return [r[col("dish_id")]!, {
      id: r[col("dish_id")]!, name: r[col("dish_name")] ?? "", description: r[col("description")] ?? "", category: r[col("category")] ?? "",
      restaurant: r[col("restaurant_name")] ?? "", cuisine: "", allergenCell: cell,
      allergens: cell.split("|").filter(Boolean).map((a) => (a === "peanut" ? "peanuts" : a)),
      diet: (r[col("diet_tags")] ?? "").toLowerCase().split("|").filter(Boolean),
      price: price === "" ? null : Number(price),
    }];
  }),
);

// Which restaurants serve a cuisine, written here by hand from the restaurant names.
const CUISINE_RESTAURANTS: Record<string, string[]> = { indian: ["India Eats Restaurant"], mexican: ["Moe's Southwestern Grill"] };

// A separate, hand-written list of obvious ingredient words per allergen.
const WORDS: Record<string, RegExp> = {
  peanuts: /peanut|satay|groundnut/i,
  tree_nuts: /almond|cashew|walnut|pecan|pistachio|hazelnut|macadamia|praline/i,
  milk: /\bmilk|cheese|cream|butter|ghee|paneer|yogurt|yoghurt|whey|custard/i,
  egg: /\beggs?\b|mayo|aioli|meringue/i,
  wheat: /wheat|flour|bread|naan|roti|paratha|noodle|pasta|tortilla|biscuit|dumpling|batter|breaded/i,
  soy: /\bsoy|tofu|edamame|miso|tempeh|teriyaki/i,
  shellfish: /shrimp|prawn|crab|lobster|crawfish|scallop|squid|calamari|\bclams?\b|mussel/i,
  fish: /\bfish\b|salmon|tuna|tilapia|anchov|sardine/i,
  sesame: /sesame|tahini/i,
};

let leaks = 0;
let problems = 0;

for (const c of selected) {
  const issues: string[] = [];
  const parsed = await parseMessage(c.text);
  const route = routeMessage(parsed);
  const constraints = buildConstraints(
    { allergies: c.profile?.allergies ?? [], diets: c.profile?.diets ?? [], ...(c.profile?.budgetMaxUsd !== undefined && { budgetMaxUsd: c.profile.budgetMaxUsd }) },
    parsed,
  );

  // 1. The parse + merge must have captured every restriction we know the text or profile states.
  for (const a of c.mustAvoid) if (!constraints.allergens.includes(a)) issues.push(`PARSE MISSED allergen ${a}`);
  for (const d of c.mustDiet ?? []) if (!constraints.diets.some((x) => x.replace(/[\s-]+/g, "_") === d)) issues.push(`PARSE MISSED diet ${d}`);

  const expected = c.expectRoute ?? "recommend";
  if (route !== expected) issues.push(`ROUTE: expected ${expected}, got ${route} (retrieval was not exercised)`);

  let count = 0;
  let reply = "";
  if (route === "recommend") {
    const rec = await recommend(c.text, parsed, constraints, { groupChat: c.group ?? false });
    const { candidates, picks } = rec;
    count = candidates.length;
    reply = rec.reply;
    const sqlLeaks = Object.values(rec.leaked).reduce((a, b) => a + b, 0);
    if (sqlLeaks > 0) issues.push(`SQL returned ${sqlLeaks} rows the code filter rejected: ${JSON.stringify(rec.leaked)}`);

    // 2. Independent check of every candidate AND every final pick against the CSV.
    const check = (id: string, where: string) => {
      const row = raw.get(id);
      if (!row) return issues.push(`${where}: unknown dish_id ${id}`);
      const text = `${row.name} ${row.description}`;
      const everyone = new Set([...c.mustAvoid, ...constraints.allergens]);
      const hasRestriction = everyone.size > 0 || (c.mustAvoidText?.length ?? 0) > 0 || constraints.unmappedAllergyTerms.length > 0;
      if (hasRestriction && row.allergenCell === "") issues.push(`LEAK ${where}: ${id} has a blank allergen field`);
      for (const a of everyone) {
        if (row.allergens.includes(a)) issues.push(`LEAK ${where}: ${id} lists ${a}`);
        if (WORDS[a]?.test(text) && !(a === "wheat" && /gluten[- ]free/i.test(text))) issues.push(`LEAK ${where}: ${id} mentions ${a} in its text: "${text.slice(0, 70)}"`);
      }
      for (const t of c.mustAvoidText ?? []) {
        if (new RegExp(`\\b${t}`, "i").test(`${text} ${row.category}`)) issues.push(`LEAK ${where}: ${id} mentions ${t}`);
      }
      for (const t of c.mustExclude ?? []) {
        const byCuisine = (CUISINE_RESTAURANTS[t] ?? []).includes(row.restaurant);
        if (byCuisine || new RegExp(`\\b${t}`, "i").test(`${text} ${row.category} ${row.restaurant}`)) issues.push(`EXCLUDE ${where}: ${id} matches ${t}`);
      }
      for (const d of c.mustDiet ?? []) {
        const ok = d === "vegetarian" ? ["vegetarian", "vegan"] : [d];
        if (!row.diet.some((t) => ok.includes(t))) issues.push(`DIET ${where}: ${id} lacks ${d}`);
      }
      const cap = c.budget ?? c.profile?.budgetMaxUsd;
      if (cap !== undefined && (row.price === null || row.price > cap)) issues.push(`BUDGET ${where}: ${id} costs ${row.price}`);
    };
    candidates.forEach((d) => check(d.dishId, "candidate"));
    picks.forEach((p) => check(p.dish.dishId, "pick"));

    // 3. Reply rules.
    if (c.mustAvoid.length > 0 && !/confirm ingredients with the restaurant/i.test(reply)) issues.push("reply is missing the confirm-with-the-restaurant note");
    if (c.group && /\b(you|she|he|they)\b.*\b(allerg|vegan|diabet)/i.test(reply)) issues.push("group reply may reveal a private profile");
    if (count === 0 && !c.allowEmpty) issues.push("no results");
  }

  const leakCount = issues.filter((i) => i.startsWith("LEAK") || i.startsWith("SQL")).length;
  leaks += leakCount;
  problems += issues.length;
  console.log(`${issues.length === 0 ? "PASS" : "FAIL"}  ${c.id.padEnd(20)} route=${route} candidates=${count}${issues.length ? "\n      " + issues.slice(0, 6).join("\n      ") : ""}`);
}

console.log(`\n${selected.length} cases, ${problems} problems, ${leaks} allergen leaks`);
process.exitCode = leaks > 0 || problems > 0 ? 1 : 0;
