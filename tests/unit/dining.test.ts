import assert from "node:assert/strict";
import test from "node:test";
import { cleanCasualName, SAFETY_CLAIM, type Pick } from "../../src/pipeline/explain.js";
import { buildRestaurantsSql, buildSearchSql } from "../../src/rag/store.js";
import type { Candidate, Constraints } from "../../src/types.js";
import { composeDishMessage, directionsPoll, dishPoll, restaurantPoll, tidyName } from "../../bot/src/dining.js";

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

test("choice polls: restaurants, dishes and directions", () => {
  const near = { restaurants: [{ name: "Queen Tea", walk_minutes: 1, miles_away: 0.1, cuisine: [], typical_meal_price: undefined }, { name: "India Eats", walk_minutes: 2, miles_away: 0.1, cuisine: [], typical_meal_price: undefined }], far_away: false, none_match_restrictions: false };
  const r = restaurantPoll(near)!;
  assert.equal(r.kind, "restaurant");
  assert.deepEqual(r.options.map((o) => o.label), ["Queen Tea · 1 min", "India Eats · 2 min"]);
  assert.deepEqual(r.options.map((o) => o.value), ["Queen Tea", "India Eats"]);
  assert.equal(restaurantPoll({ ...near, far_away: true }), undefined); // nothing near them: no poll, the model says so
  assert.equal(restaurantPoll({ ...near, restaurants: near.restaurants.slice(0, 1) }), undefined); // a poll needs two options

  const choices = [{ label: "Beef Rice ($14.99)", name: "Beef Rice", calories: 650, proteinG: 38 }, { label: "Nuggets ($10.39)", name: "Nuggets", calories: null, proteinG: null }];
  assert.equal(dishPoll("Queen Tea", choices)!.options[0]!.value, "Beef Rice");
  assert.equal(dishPoll("Queen Tea", choices.slice(0, 1)), undefined);

  const d = directionsPoll("Queen Tea");
  assert.deepEqual(d.options.map((o) => o.value), ["yes", "no"]);
  assert.match(d.title, /Queen Tea/);
});
