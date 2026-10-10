import assert from "node:assert/strict";
import test from "node:test";
import { cleanCasualName, SAFETY_CLAIM, type Pick } from "../../src/pipeline/explain.js";
import { buildRestaurantsSql, buildSearchSql } from "../../src/rag/store.js";
import type { Candidate, Constraints } from "../../src/types.js";
import { wantsFood } from "../../bot/src/llm.js";
import { composeDishMessage, dishPoll, pickVaried, restaurantPoll, spotsText, tidyName } from "../../bot/src/dining.js";

const none: Constraints = { allergens: [], unmappedAllergyTerms: [], diets: [], excludeTerms: [] };
const peanut: Constraints = { ...none, allergens: ["peanuts"] };

const dish = (over: Partial<Candidate> = {}): Candidate => ({
  dishId: "r__d", restaurantId: "r", restaurantName: "Moe's Southwestern Grill", placeId: "", lat: 0, lng: 0,
  dishName: "MOE PROTEIN BURRITO - SERVED WITH RICE", description: "", category: "", itemKind: "meal", cuisine: [],
  priceUsd: 14.99, calories: 900, proteinG: 65, carbsG: null, fatG: null, sodiumMg: null, nutritionSource: "estimated",
  allergens: [], allergensKnown: true, allergenSource: "chart", dietTags: [], similarity: 0.5, ...over,
});

test("restaurant filter is a bound parameter, never part of the SQL text", () => {
  const { sql, params } = buildSearchSql(none, 10, ["meal"], "moes'; DROP TABLE dishes;--");
  assert.match(sql, /restaurant_id = :restaurant_id/);
  assert.equal(params.restaurant_id, "moes'; DROP TABLE dishes;--");
  assert.ok(!sql.includes("DROP TABLE"));
});

test("the restaurant list applies exactly the same allergy and diet filters as dish search", () => {
  const c: Constraints = { ...peanut, diets: ["vegan"], budgetMaxUsd: 12, excludeTerms: ["fries"] };
  const search = buildSearchSql(c, 10, ["meal"]);
  const list = buildRestaurantsSql(c, ["meal"]);
  assert.deepEqual(list.params, search.params);
  for (const clause of ["allergens_known", "NOT (allergens &&", "diet_tags &&", "price_usd <=", "~* :exclude"]) {
    assert.ok(list.sql.includes(clause), `restaurant list is missing: ${clause}`);
  }
  assert.match(list.sql, /GROUP BY restaurant_id/);
});

test("a casual dish name may only reuse words from the menu name", () => {
  const d = dish({ dishName: "CHICKEN TIKKA MASALLA - SERVED WITH RICE" });
  assert.equal(cleanCasualName("chicken tikka masalla", d), "chicken tikka masalla");
  assert.equal(cleanCasualName("chicken tikka masalla with cashews", d), undefined); // invented ingredient
  assert.equal(cleanCasualName("", d), undefined);
  assert.equal(cleanCasualName(42, d), undefined);
});

test("tidyName drops menu noise and un-shouts", () => {
  assert.equal(tidyName("CHICKEN TIKKA MASALLA - SERVED WITH RICE"), "chicken tikka masalla");
  assert.equal(tidyName("Beef Rice"), "Beef Rice");
  assert.equal(tidyName("Tofu Tikka Masala - Served with rice"), "Tofu Tikka Masala");
});

test("dish message: allergy note comes from code and is only there for allergies", () => {
  const picks: Pick[] = [{ dish: dish(), reason: "packed with 65g protein" }, { dish: dish({ dishId: "r__e", dishName: "Quesadilla" }), reason: "A solid pick at Moe's Southwestern Grill." }];
  const withAllergy = composeDishMessage("Moe's", picks, peanut);
  assert.match(withAllergy, /double check|estimate/i);
  assert.doesNotMatch(composeDishMessage("Moe's", picks, none), /double check|estimate/i);
  // The generic fallback reason is replaced by facts from the data, never shown as-is.
  assert.doesNotMatch(withAllergy, /solid pick/i);
  assert.match(withAllergy, /65g protein/);
});

test("dish message never claims a dish is safe or allergen-free", () => {
  const picks: Pick[] = [{ dish: dish({ allergenSource: "estimated" }), reason: "packed with protein" }, { dish: dish({ dishId: "r__e" }), reason: "crispy" }];
  for (let i = 0; i < 30; i++) assert.doesNotMatch(composeDishMessage("Moe's", picks, peanut), SAFETY_CLAIM);
});

const spot = (name: string, walk_minutes: number) => ({ name, walk_minutes, miles_away: 0.1, cuisine: [], typical_meal_price: undefined });

test("the text that names the spots and the poll come from the same three", () => {
  const near = { restaurants: [spot("Saxby's", 2), spot("Queen Tea", 3), spot("India Eats", 3), spot("Mr. Fries Man", 4)], far_away: false, none_match_restrictions: false };
  const poll = restaurantPoll(near)!;
  assert.equal(poll.kind, "restaurant");
  assert.equal(poll.options.length, 3); // capped at three, never four
  assert.deepEqual(poll.options.map((o) => o.value), ["Saxby's", "Queen Tea", "India Eats"]);
  assert.deepEqual(poll.options.map((o) => o.label), ["Saxby's · 2 min", "Queen Tea · 3 min", "India Eats · 3 min"]);
  // Every option is named, with its walk time, in the text that comes right before the poll.
  for (let i = 0; i < 20; i++) {
    const text = restaurantPoll(near)!.intro!;
    for (const o of poll.options) assert.ok(text.includes(o.value), `intro is missing ${o.value}: ${text}`);
    assert.ok(!text.includes("Mr. Fries Man"), "the fourth spot must not be mentioned");
    for (const m of ["2 min", "3 min"]) assert.ok(text.includes(m));
  }
  assert.equal(spotsText([spot("A", 1), spot("B", 2)]), "A is 1 min away, B is 2 min");
});

test("no poll when nothing is near or there's only one spot", () => {
  const one = { restaurants: [spot("Queen Tea", 1)], far_away: false, none_match_restrictions: false };
  assert.equal(restaurantPoll(one), undefined);
  assert.equal(restaurantPoll({ ...one, restaurants: [spot("A", 1), spot("B", 2)], far_away: true }), undefined);
});

test("spots are varied: not two cafes while something different is close", () => {
  const e = (id: string, cuisine: string[], km: number) => ({ id, r: { cuisine }, km });
  const sorted = [e("saxbys", ["cafe"], 0.1), e("starbucks", ["cafe"], 0.2), e("queen", ["taiwanese"], 0.3), e("india", ["indian"], 0.4)];
  assert.deepEqual(pickVaried(sorted, 3).map((x) => x.id), ["saxbys", "queen", "india"]);
  // Not enough variety: fall back to nearest rather than offering fewer.
  const cafes = [e("a", ["cafe"], 0.1), e("b", ["cafe"], 0.2), e("c", ["cafe"], 0.3)];
  assert.deepEqual(pickVaried(cafes, 3).map((x) => x.id), ["a", "b", "c"]);
});

test("dish poll needs two choices", () => {
  const choices = [{ label: "Beef Rice ($14.99)", name: "Beef Rice", calories: 650, proteinG: 38 }, { label: "Nuggets ($10.39)", name: "Nuggets", calories: null, proteinG: null }];
  assert.equal(dishPoll("Queen Tea", choices)!.options[0]!.value, "Beef Rice");
  assert.equal(dishPoll("Queen Tea", choices.slice(0, 1)), undefined);
});

test("food requests are recognised, small talk and mid-flow answers are not", () => {
  for (const yes of ["Need a place to eat with my friend", "im hungry", "yo i'm starving", "what should we eat", "where should i eat tonight", "wanna eat", "can you make a poll for where to eat", "need some food", "lunch spot?", "I sent you a voice note. Respond. Transcript: \"i'm hungry\""]) {
    assert.ok(wantsFood(yes), `should match: ${yes}`);
  }
  for (const no of ["hey", "what's up", "queen tea", "the beef rice", "yeah", "thanks", "how many calories in a burrito", "i had pizza for lunch", "my goal is 1800 cal", "I'm allergic to peanuts"]) {
    assert.ok(!wantsFood(no), `should not match: ${no}`);
  }
});
