import { test } from "node:test";
import assert from "node:assert/strict";
import { loadCatalog } from "../../src/data/catalog.js";
import { dietAcceptableTags, filterDishes, hardFilterReason } from "../../src/pipeline/filter.js";
import { CANONICAL_ALLERGENS, isRealAllergen, meatAvoidance, normalizeAllergies } from "../../src/pipeline/allergens.js";
import { buildConstraints, type ParsedMessage } from "../../src/pipeline/parse.js";
import type { Constraints, Dish } from "../../src/types.js";

const none: Constraints = { allergens: [], unmappedAllergyTerms: [], diets: [], excludeTerms: [] };
const catalog = loadCatalog("data/gsu_dishes.csv");

const dish = (over: Partial<Dish>): Dish => ({
  dishId: "t__x",
  restaurantId: "t",
  restaurantName: "Test Kitchen",
  placeId: "",
  lat: 33.75,
  lng: -84.38,
  dishName: "Test Dish",
  description: "",
  category: "",
  itemKind: "meal",
  cuisine: [],
  priceUsd: 8,
  calories: 500,
  proteinG: 20,
  carbsG: 50,
  fatG: 15,
  sodiumMg: 600,
  nutritionSource: "official",
  allergens: ["wheat"],
  allergensKnown: true,
  allergenSource: "chart",
  dietTags: [],
  ...over,
});

test("a dish with unknown allergens is excluded for anyone with an allergy", () => {
  const unknown = dish({ allergens: [], allergensKnown: false });
  assert.equal(hardFilterReason(unknown, { ...none, allergens: ["peanuts"] }), "allergen_unknown");
  assert.equal(hardFilterReason(unknown, none), null, "no allergy means no restriction");
});

test("an unmapped allergy term also excludes unknown-allergen dishes", () => {
  const unknown = dish({ allergens: [], allergensKnown: false });
  assert.equal(hardFilterReason(unknown, { ...none, unmappedAllergyTerms: ["kiwi"] }), "allergen_unknown");
});

test("a listed allergen excludes the dish", () => {
  assert.equal(hardFilterReason(dish({ allergens: ["milk", "soy"] }), { ...none, allergens: ["soy"] }), "allergen");
  assert.equal(hardFilterReason(dish({ allergens: ["milk"] }), { ...none, allergens: ["soy"] }), null);
});

test("an unmapped allergy term is matched against the dish text", () => {
  const c: Constraints = { ...none, unmappedAllergyTerms: ["coconut"] };
  assert.equal(hardFilterReason(dish({ dishName: "Coconut Latte" }), c), "allergy_text");
  assert.equal(hardFilterReason(dish({ description: "Toasted coconut syrup" }), c), "allergy_text");
  assert.equal(hardFilterReason(dish({ dishName: "Plain Latte" }), c), null);
});

test("allergy synonyms map onto catalog names, including the peanut/peanuts mismatch", () => {
  assert.deepEqual(normalizeAllergies(["Peanut"]).allergens, ["peanuts"]);
  assert.deepEqual(normalizeAllergies(["dairy", "Lactose"]).allergens, ["milk"]);
  assert.deepEqual(normalizeAllergies(["gluten"]).allergens, ["wheat"]);
  assert.deepEqual(normalizeAllergies(["nuts"]).allergens, ["peanuts", "tree_nuts"]);
  assert.deepEqual(normalizeAllergies(["peanut allergy"]).allergens, ["peanuts"]);
  assert.deepEqual(normalizeAllergies(["kiwi"]), { allergens: [], unmapped: ["kiwi"] }, "unknown terms are kept, never dropped");
});

test("diet is presence-required; vegetarian accepts vegan; unknown diets match nothing", () => {
  assert.deepEqual(dietAcceptableTags("Gluten Free"), ["gluten_free"]);
  assert.equal(hardFilterReason(dish({ dietTags: ["vegan"] }), { ...none, diets: ["vegetarian"] }), null);
  assert.equal(hardFilterReason(dish({ dietTags: ["vegetarian"] }), { ...none, diets: ["vegan"] }), "diet");
  assert.equal(hardFilterReason(dish({ dietTags: [] }), { ...none, diets: ["vegan"] }), "diet");
  // Halal exists only as an inference for Starbucks and Saxby's meat-free items (data/enrich_gaps.py). Anything else
  // has no halal tag and must never come back, and a halal result must never be a meat dish.
  const halal = filterDishes(catalog, { ...none, diets: ["halal"] }).kept;
  assert.ok(halal.length > 0);
  for (const d of halal) {
    assert.ok(["starbucks", "saxbys"].includes(d.restaurantId), `${d.dishId} is halal only by inference at the two chains`);
    assert.equal(d.dietSource, "inferred", d.dishId);
    assert.ok(d.dietTags.includes("vegetarian") || d.dietTags.includes("vegan"), `${d.dishId}: halal-tagged dishes are meat-free`);
  }
});

test("budget excludes over-budget and unknown-price dishes", () => {
  const c = { ...none, budgetMaxUsd: 10 };
  assert.equal(hardFilterReason(dish({ priceUsd: 10 }), c), null);
  assert.equal(hardFilterReason(dish({ priceUsd: 10.5 }), c), "budget");
  assert.equal(hardFilterReason(dish({ priceUsd: null }), c), "budget");
});

test("exclude terms match name, description, category and restaurant", () => {
  const c = { ...none, excludeTerms: ["mexican"] };
  assert.equal(hardFilterReason(dish({ description: "Mexican street corn" }), c), "excluded");
  assert.equal(hardFilterReason(dish({ restaurantName: "Mexican Grill" }), c), "excluded");
  assert.equal(hardFilterReason(dish({}), c), null);
});

// ---- Property tests over the real catalog: these are the zero-leak guarantees. ----

test("catalog: for every canonical allergen, no kept dish lists it and every kept dish has known allergens", () => {
  for (const allergen of CANONICAL_ALLERGENS) {
    const { kept } = filterDishes(catalog, { ...none, allergens: [allergen] });
    assert.ok(kept.length > 0, `${allergen}: expected some safe dishes`);
    for (const d of kept) {
      if (isRealAllergen(allergen)) assert.ok(d.allergensKnown, `${allergen}: ${d.dishId} has unknown allergens`);
      assert.ok(!d.allergens.includes(allergen), `${allergen} leaked: ${d.dishId} lists ${d.allergens.join(",")}`);
    }
  }
});

test("catalog: all allergens at once leaves only known dishes with none of them", () => {
  const { kept } = filterDishes(catalog, { ...none, allergens: [...CANONICAL_ALLERGENS] });
  for (const d of kept) {
    assert.ok(d.allergensKnown);
    assert.equal(d.allergens.filter((a) => (CANONICAL_ALLERGENS as readonly string[]).includes(a)).length, 0);
  }
});

// Written separately from ALLERGEN_KEYWORDS on purpose: if the shared list is wrong, this one still catches it.
const OBVIOUS_WORDS: Record<string, RegExp> = {
  peanuts: /peanut|satay/i,
  tree_nuts: /almond|cashew|walnut|pecan|pistachio|hazelnut/i,
  milk: /\bmilk|cheese|cream|butter|ghee|paneer|yogurt|yoghurt/i,
  egg: /\beggs?\b|mayo|aioli/i,
  wheat: /wheat|flour|bread|naan|noodle|pasta|tortilla/i,
  soy: /\bsoy|tofu|edamame|miso/i,
  shellfish: /shrimp|prawn|crab|lobster|crawfish/i,
  fish: /\bfish\b|salmon|tuna|tilapia|anchov/i,
  sesame: /sesame|tahini/i,
  beef: /beef|steak|burger|brisket|meatball/i,
  pork: /pork|bacon|sausage|pepperoni|prosciutto|chorizo|carnitas/i,
};
const GF = /gluten[- ]free/i;

test("catalog: 'allergic to peanuts, recommend Thai' with the shape the live parser produces", () => {
  // The parser only ever yields { allergens: ['peanuts'] }. It never yields unmapped terms for peanuts.
  const { kept } = filterDishes(catalog, { ...none, allergens: ["peanuts"] });
  assert.ok(kept.length > 0);
  for (const d of kept) {
    assert.ok(!d.allergens.includes("peanuts"), d.dishId);
    assert.ok(!/peanut|satay/i.test(`${d.dishName} ${d.description}`), `${d.dishId} mentions peanut in its text`);
  }
});

test("catalog: for every allergen, no survivor's name or description mentions it (independent word list)", () => {
  for (const allergen of CANONICAL_ALLERGENS) {
    const word = OBVIOUS_WORDS[allergen]!;
    const { kept } = filterDishes(catalog, { ...none, allergens: [allergen] });
    for (const d of kept) {
      const text = `${d.dishName} ${d.description}`;
      if (allergen === "wheat" && GF.test(text)) continue;
      assert.ok(!word.test(text), `${allergen} leaked via text: ${d.dishId}: ${text.slice(0, 90)}`);
    }
  }
});

test("an estimated allergen cell that misses what the description says is still caught", () => {
  const sneaky = dish({ allergens: ["wheat"], allergenSource: "estimated", description: "Rice tossed with chopped peanuts" });
  assert.equal(hardFilterReason(sneaky, { ...none, allergens: ["peanuts"] }), "allergen_text");
  assert.equal(hardFilterReason(dish({ allergens: ["soy"], description: "with cashew paste" }), { ...none, allergens: ["tree_nuts"] }), "allergen_text");
  assert.equal(hardFilterReason(dish({ allergens: ["wheat"], dishName: "Fried Oyster Mushrooms" }), { ...none, allergens: ["shellfish"] }), "allergen_text", "false positives are the accepted direction");
});

test("a gluten-free claim exempts a dish from wheat keywords only, never from the allergen cell or other allergens", () => {
  const gf = dish({ allergens: ["soy"], dishName: "Gluten Free Burrito", description: "flour tortilla alternative" });
  assert.equal(hardFilterReason(gf, { ...none, allergens: ["wheat"] }), null);
  assert.equal(hardFilterReason({ ...gf, allergens: ["wheat"] }, { ...none, allergens: ["wheat"] }), "allergen");
  assert.equal(hardFilterReason({ ...gf, description: "with cashew cream" }, { ...none, allergens: ["tree_nuts"] }), "allergen_text");
});

test("catalog: a dairy allergy never returns a dish whose allergen list is blank", () => {
  const blank = new Set(catalog.filter((d) => !d.allergensKnown).map((d) => d.dishId));
  assert.ok(blank.size > 0, "fixture sanity: the catalog has blank-allergen dishes");
  const { kept } = filterDishes(catalog, { ...none, allergens: ["milk"] });
  for (const d of kept) assert.ok(!blank.has(d.dishId), `${d.dishId} has a blank allergen field`);
});

// ---- beef and pork: diet avoidances found from dish text ----

test("avoiding pork or beef drops dishes that name it, even when the allergen cell is blank", () => {
  const bacon = dish({ dishName: "Bacon, Gouda & Egg Sandwich", allergens: [], allergensKnown: false });
  assert.equal(hardFilterReason(bacon, { ...none, allergens: ["pork"] }), "allergen_text");
  assert.equal(hardFilterReason(dish({ dishName: "Double Cheeseburger" }), { ...none, allergens: ["beef"] }), "allergen_text");
  // not an allergy: a plain drink with a blank allergen cell is still fine for someone avoiding pork
  assert.equal(hardFilterReason(dish({ dishName: "Cold Brew", allergens: [], allergensKnown: false }), { ...none, allergens: ["pork"] }), null);
  // but a real allergy alongside it still excludes unknown dishes
  assert.equal(hardFilterReason(dish({ dishName: "Cold Brew", allergens: [], allergensKnown: false }), { ...none, allergens: ["pork", "milk"] }), "allergen_unknown");
});

test("no pork / pork-free / no_beef / red meat as a diet become avoidances, not required tags", () => {
  assert.deepEqual(meatAvoidance("No Pork"), ["pork"]);
  assert.deepEqual(meatAvoidance("pork-free"), ["pork"]);
  assert.deepEqual(meatAvoidance("no_beef"), ["beef"]);
  assert.deepEqual(meatAvoidance("red meat"), ["beef", "pork"]);
  assert.equal(meatAvoidance("vegan"), null);
  const parsed: ParsedMessage = { intent: "food_request", positiveQuery: "", allergies: [], diets: ["no_pork", "halal"], exclude: [] };
  const c = buildConstraints({ allergies: [], diets: ["No beef"] }, parsed);
  assert.deepEqual(c.allergens, ["beef", "pork"]);
  assert.deepEqual(c.diets, ["halal"]);
  assert.deepEqual(normalizeAllergies(["no pork", "fish", "nuts"]).allergens, ["fish", "peanuts", "pork", "tree_nuts"]);
});

test("catalog: avoiding beef and pork leaves dishes that name neither", () => {
  for (const meat of ["beef", "pork"]) {
    const { kept } = filterDishes(catalog, { ...none, allergens: [meat] });
    assert.ok(kept.length > 100, `${meat}: expected plenty of meat-free dishes`);
    for (const d of kept) assert.ok(!OBVIOUS_WORDS[meat]!.test(`${d.dishName} ${d.description}`), `${meat} leaked: ${d.dishId}`);
  }
});
