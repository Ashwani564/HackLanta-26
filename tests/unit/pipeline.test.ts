import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyKind, dedupeDishes, dishesFromCsv, loadCatalog, parseCsv } from "../../src/data/catalog.js";
import { buildSearchSql } from "../../src/rag/store.js";
import { cleanReason, validatePicks } from "../../src/pipeline/explain.js";
import { buildConstraints, sanitizeParse } from "../../src/pipeline/parse.js";
import { retrievalKinds, retrievalQuery, routeMessage } from "../../src/pipeline/route.js";
import { goalFit, priceFit, rankDishes } from "../../src/pipeline/score.js";
import { formatReply } from "../../src/pipeline/format.js";
import { embeddingText } from "../../src/rag/embedText.js";
import type { Candidate, Constraints } from "../../src/types.js";

const none: Constraints = { allergens: [], unmappedAllergyTerms: [], diets: [], excludeTerms: [] };

const cand = (over: Partial<Candidate> = {}): Candidate => ({
  dishId: "r__a",
  restaurantId: "r",
  restaurantName: "Rest",
  placeId: "",
  lat: 33.7531,
  lng: -84.3853,
  dishName: "Dish A",
  description: "",
  category: "",
  itemKind: "meal",
  cuisine: [],
  priceUsd: 9,
  calories: 500,
  proteinG: 30,
  carbsG: 40,
  fatG: 10,
  sodiumMg: 700,
  nutritionSource: "official",
  allergens: [],
  allergensKnown: true,
  allergenSource: "chart",
  dietTags: [],
  similarity: 0.5,
  ...over,
});

// ---- catalog ----

test("csv parser handles quotes, commas, escaped quotes and newlines", () => {
  const rows = parseCsv('a,b\n"x, y","say ""hi"""\n"line1\nline2",z\n');
  assert.deepEqual(rows, [["a", "b"], ["x, y", 'say "hi"'], ["line1\nline2", "z"]]);
});

test("catalog loads 825 dishes from 9 restaurants and treats blank allergens as unknown", () => {
  const dishes = loadCatalog("data/gsu_dishes.csv");
  assert.equal(dishes.length, 825);
  assert.equal(new Set(dishes.map((d) => d.restaurantId)).size, 9);
  for (const d of dishes) {
    // A listed allergen means the cell was filled. The only known-but-empty rows are the ones marked "none",
    // which data/enrich_gaps.py writes together with allergen_source=inferred (never as a stated "none").
    if (d.allergens.length > 0) assert.ok(d.allergensKnown, d.dishId);
    if (d.allergensKnown && d.allergens.length === 0) assert.equal(d.allergenSource, "inferred", d.dishId);
  }
});

test("catalog rejects duplicate IDs and missing columns", () => {
  assert.throws(() => dishesFromCsv("dish_id\nx"), /missing column/);
  const header = "dish_id,restaurant_id,restaurant_name,dish_name,lat,lng,allergens,allergen_source";
  assert.throws(() => dishesFromCsv(`${header}\na,r,R,D,1,2,,\na,r,R,D,1,2,,`), /duplicate/);
});

// ---- SQL ----

test("search SQL carries the hard filters and binds user text as parameters", () => {
  const evil = "x'; DROP TABLE dishes; --";
  const { sql, params } = buildSearchSql(
    { allergens: ["milk"], unmappedAllergyTerms: [evil], diets: ["vegetarian"], budgetMaxUsd: 12, excludeTerms: ["fries"] },
    40,
  );
  assert.match(sql, /allergens_known/);
  assert.match(sql, /NOT \(allergens && string_to_array\(:allergens/);
  assert.match(sql, /NOT \(\(dish_name \|\| ' ' \|\| COALESCE\(description, ''\)\) ~\* :allergen_kw\)/, "ingredient keywords are enforced in SQL too");
  assert.match(String(params.allergen_kw), /milk/);
  assert.match(sql, /diet_tags && string_to_array\(:diet_0/);
  assert.match(sql, /price_usd IS NOT NULL AND price_usd <= /);
  assert.ok(!sql.includes("DROP TABLE"), "user text must never be interpolated into SQL");
  assert.equal(params.diet_0, "vegetarian,vegan");
  assert.equal(params.allergens, "milk");
  assert.match(String(params.allergy_text), /DROP TABLE/, "the term travels as a bound parameter instead");
});

test("search SQL with no constraints has no WHERE clause and clamps the limit", () => {
  const { sql } = buildSearchSql(none, 99999);
  assert.ok(!/\bWHERE\b/.test(sql));
  assert.match(sql, /LIMIT 100$/);
});

test("any allergy requires known allergens in SQL, even when the term is unmapped", () => {
  const { sql } = buildSearchSql({ ...none, unmappedAllergyTerms: ["kiwi"] }, 10);
  assert.match(sql, /WHERE allergens_known/);
});

// ---- explain: the LLM can only choose from what code sent ----

test("picks with unknown or duplicate dish IDs are dropped and backfilled from the ranked list", () => {
  const ranked = [cand({ dishId: "r__a" }), cand({ dishId: "r__b" }), cand({ dishId: "r__c" }), cand({ dishId: "r__d" })];
  const picks = validatePicks(
    { picks: [{ dish_id: "evil__peanut", reason: "x" }, { dish_id: "r__b", reason: "Great." }, { dish_id: "r__b", reason: "dup" }] },
    ranked,
  );
  assert.deepEqual(picks.map((p) => p.dish.dishId), ["r__b", "r__a", "r__c"]);
  assert.equal(picks[0]!.reason, "Great.");
});

test("an invented dish ID can never appear in the result", () => {
  const ranked = [cand({ dishId: "r__a" })];
  const picks = validatePicks({ picks: [{ dish_id: "made-up", reason: "x" }, { dish_id: 7 as unknown as string, reason: "y" }] }, ranked);
  assert.deepEqual(picks.map((p) => p.dish.dishId), ["r__a"]);
});

test("a reason that claims safety is replaced", () => {
  const d = cand();
  for (const bad of ["Totally safe for allergies!", "It is allergen-free.", "Free of dairy", "No peanuts here", "I guarantee it"]) {
    assert.match(cleanReason(bad, d), /solid pick/, bad);
  }
  assert.equal(cleanReason("Crispy and filling.", d), "Crispy and filling.");
});

// ---- parse / route ----

test("sanitizeParse drops values outside the schema", () => {
  const p = sanitizeParse({ intent: "hack", positive_query: " thai ", allergies: ["peanut", 3, ""], goal: "bulk", budget_max_usd: -4 });
  assert.equal(p.intent, "food_request");
  assert.equal(p.positiveQuery, "thai");
  assert.deepEqual(p.allergies, ["peanut"]);
  assert.equal(p.goal, undefined);
  assert.equal(p.budgetMaxUsd, undefined);
});

test("constraints only accumulate: profile allergies survive, budget is the minimum", () => {
  const parsed = sanitizeParse({ intent: "food_request", positive_query: "ramen", allergies: ["shrimp"], diets: [], exclude: ["Pork"], budget_max_usd: 15 });
  const c = buildConstraints({ allergies: ["peanut"], diets: ["vegetarian"], budgetMaxUsd: 10 }, parsed);
  assert.deepEqual(c.allergens, ["peanuts", "shellfish"]);
  assert.deepEqual(c.diets, ["vegetarian"]);
  assert.equal(c.budgetMaxUsd, 10);
  assert.deepEqual(c.excludeTerms, ["pork"]);
});

test("routing: only food requests and follow-ups reach retrieval", () => {
  const r = (intent: string) => routeMessage(sanitizeParse({ intent }));
  assert.equal(r("food_request"), "recommend");
  assert.equal(r("followup"), "recommend");
  assert.equal(r("profile_update"), "update_profile");
  assert.equal(r("smalltalk"), "reply_only");
});

test("a follow-up with no food words reuses the previous query", () => {
  const followup = sanitizeParse({ intent: "followup", positive_query: "", followup: "cheaper" });
  assert.equal(retrievalQuery(followup, "spicy chicken wings"), "spicy chicken wings");
  assert.equal(retrievalQuery(sanitizeParse({ intent: "food_request", positive_query: "" })), "a satisfying meal");
});

// ---- score ----

test("goal fit is soft, averaged, and unknown nutrition scores below neutral", () => {
  assert.equal(goalFit(cand(), []), 0.5);
  assert.ok(goalFit(cand({ proteinG: 40 }), ["high_protein"]) > goalFit(cand({ proteinG: 5 }), ["high_protein"]));
  assert.ok(goalFit(cand({ proteinG: null }), ["high_protein"]) < 0.5);
  assert.ok(priceFit(cand({ priceUsd: null }), 10) < 0.5);
});

test("ranking is deterministic and prefers closer, cheaper, on-goal dishes", () => {
  const near = cand({ dishId: "n", priceUsd: 5, proteinG: 38 });
  const far = cand({ dishId: "f", priceUsd: 14, proteinG: 8, lat: 33.76, lng: -84.37 });
  const ranked = rankDishes([far, near], { goals: ["high_protein"], budgetMaxUsd: 15, origin: { lat: 33.7531, lng: -84.3853 } });
  assert.deepEqual(ranked.map((c) => c.dishId), ["n", "f"]);
});

// ---- format ----

test("replies with allergies end with the confirm-with-restaurant note and never name anyone", () => {
  const c: Constraints = { ...none, allergens: ["peanuts"] };
  const text = formatReply([{ dish: cand({ allergenSource: "estimated" }), reason: "Crispy." }], c, { groupChat: true });
  assert.match(text, /^Works for everyone's restrictions:/);
  assert.match(text, /allergen info is estimated/);
  assert.match(text.split("\n").at(-1)!, /confirm ingredients with the restaurant/i);
  assert.match(text, /https:\/\/maps\.apple\.com\/\?daddr=33\.7531,-84\.3853&dirflg=w/);
});

test("replies without allergies carry no allergy note", () => {
  assert.ok(!/allergy/i.test(formatReply([{ dish: cand(), reason: "Nice." }], none)));
});

// ---- embedding text ----

test("embedding text never mentions allergens and labels nutrition in plain words", () => {
  const text = embeddingText(cand({ allergens: ["peanuts"], proteinG: 30, calories: 350, dietTags: ["vegan"] }));
  assert.ok(!/peanut/i.test(text));
  assert.match(text, /high protein/);
  assert.match(text, /low calorie/);
  assert.match(text, /Diet: vegan/);
});

// ---- item kinds ----

test("menu sections are classified so sauces, drinks and sides stay out of meal searches", () => {
  const expect: Record<string, string> = {
    Sauces: "addon", EXTRAS: "addon", "Add-ons": "addon", Relishes: "addon",
    "Cold Coffee & Espresso": "drink", "Fruit Teas": "drink", Beverages: "drink", "Protein Beverages": "drink",
    Desserts: "dessert", Treats: "dessert",
    "Dips & Sides": "side", Bakery: "side", Appetizers: "side", Breads: "side", Snacks: "side",
    "Entree Plates": "meal", "Chef Special Curries": "meal", Bowls: "meal", "Breakfast All Day": "meal", "Rice Bowl": "meal",
  };
  for (const [category, kind] of Object.entries(expect)) assert.equal(classifyKind(category), kind, category);
});

test("catalog: most items are drinks or sides, but there are enough meals to recommend", () => {
  const dishes = loadCatalog("data/gsu_dishes.csv");
  const counts = new Map<string, number>();
  for (const d of dishes) counts.set(d.itemKind, (counts.get(d.itemKind) ?? 0) + 1);
  assert.ok((counts.get("meal") ?? 0) >= 150, JSON.stringify([...counts]));
  assert.ok(!dishes.some((d) => d.itemKind === "meal" && /sauce|add-?on|extras/i.test(d.category)));
});

test("kind filter: meals by default, any when asked, and never user-supplied SQL", () => {
  assert.deepEqual(retrievalKinds(sanitizeParse({ intent: "food_request" })), ["meal"]);
  assert.deepEqual(retrievalKinds(sanitizeParse({ intent: "food_request", item_kind: "drink" })), ["drink"]);
  assert.deepEqual(retrievalKinds(sanitizeParse({ intent: "food_request", item_kind: "any" })), []);
  assert.deepEqual(retrievalKinds(sanitizeParse({ intent: "food_request", item_kind: "'; DROP TABLE" })), ["meal"]);
  const { sql, params } = buildSearchSql(none, 10, ["meal", "bogus" as never]);
  assert.match(sql, /item_kind = ANY\(string_to_array\(:kinds/);
  assert.equal(params.kinds, "meal");
});

test("exact duplicates from the scrape collapse, but copies with different allergens are all kept", () => {
  const a = cand({ dishId: "r__rice", dishName: "Plain Rice", allergens: ["soy"] });
  const sameAgain = cand({ dishId: "r__rice-2", dishName: "plain rice ", allergens: ["soy"] });
  const differs = cand({ dishId: "r__rice-3", dishName: "Plain Rice", allergens: ["soy", "peanuts"] });
  const unknownA = cand({ dishId: "r__rice-4", dishName: "Plain Rice", allergens: [], allergensKnown: false });
  assert.deepEqual(dedupeDishes([a, sameAgain, differs, unknownA]).map((d) => d.dishId), ["r__rice", "r__rice-3", "r__rice-4"]);
});

test("catalog: collapsing duplicates removes only exact copies and keeps every restaurant", () => {
  const all = loadCatalog("data/gsu_dishes.csv");
  const deduped = dedupeDishes(all);
  assert.ok(deduped.length < all.length && deduped.length > 700, String(deduped.length));
  assert.equal(new Set(deduped.map((d) => d.restaurantId)).size, 9);
  // Every distinct allergen set seen for a (restaurant, dish name) pair must survive.
  const sets = (ds: typeof all) => new Set(ds.map((d) => `${d.restaurantId}|${d.dishName.toLowerCase()}|${d.allergensKnown ? d.allergens.join(",") : "?"}`));
  assert.deepEqual([...sets(deduped)].sort(), [...sets(all)].sort());
});

test("plain rice is a side, not a meal, whatever menu section it was scraped into", () => {
  for (const name of ["Plain Rice", "Brown Rice", "Basmati Rice"]) assert.equal(classifyKind("Tandoori Specialties", name), "side", name);
  assert.equal(classifyKind("Fried Rice", "Chicken Fried Rice"), "meal");
});

test("price fit rewards fitting the budget, not being the cheapest", () => {
  assert.equal(priceFit(cand({ priceUsd: 4 }), 12), priceFit(cand({ priceUsd: 11 }), 12));
});

test("a gluten-free diet also avoids wheat, and celiac maps to wheat", () => {
  const parsed = sanitizeParse({ intent: "food_request", diets: ["Gluten Free"] });
  const c = buildConstraints({ allergies: [], diets: [] }, parsed);
  assert.deepEqual(c.allergens, ["wheat"]);
  assert.deepEqual(c.diets, ["gluten free"]);
  assert.deepEqual(buildConstraints({ allergies: ["celiac"], diets: [] }, sanitizeParse({ intent: "food_request" })).allergens, ["wheat"]);
});

test("an empty result still ends with the allergy note when allergies are in play", () => {
  const withAllergy = formatReply([], { ...none, allergens: ["milk"] });
  assert.match(withAllergy.split("\n").at(-1)!, /confirm ingredients with the restaurant/i);
  assert.ok(!/allergy/i.test(formatReply([], none)));
});

test("cuisine tags make 'not mexican' and 'thai' matchable, and reach the embedding text", async () => {
  const { hardFilterReason } = await import("../../src/pipeline/filter.js");
  const moes = loadCatalog("data/gsu_dishes.csv").find((d) => d.restaurantId === "moes")!;
  assert.deepEqual(moes.cuisine, ["mexican", "tex-mex"]);
  assert.equal(hardFilterReason(moes, { ...none, excludeTerms: ["mexican"] }), "excluded");
  assert.match(embeddingText(moes), /Cuisine: mexican, tex-mex/);
  assert.match(buildSearchSql({ ...none, excludeTerms: ["mexican"] }, 5).sql, /array_to_string\(cuisine/);
});

test("SQL keyword filters: general allergens and wheat (with the gluten-free exemption) are separate bound parameters", () => {
  const { sql, params } = buildSearchSql({ ...none, allergens: ["peanuts", "wheat"] }, 10);
  assert.match(String(params.allergen_kw), /peanut/);
  assert.ok(!/flour/.test(String(params.allergen_kw)), "wheat words must not leak into the general pattern");
  assert.match(String(params.allergen_kw_wheat), /flour/);
  assert.match(sql, /:allergen_kw_wheat AND NOT .* ~\* 'gluten\[- \]free'/);
  assert.ok(!sql.includes("peanut"), "keywords travel as parameters, never inlined");
});
