import assert from "node:assert/strict";
import test from "node:test";
import { budgetLeft, getDay, logMeal, summary, totals } from "../../bot/src/day.js";

const meal = { name: "Chicken tikka masala", calories: 790, protein: 52, price: 14 };

test("the monthly budget defaults to $150 and shrinks by what's logged", async () => {
  const user = "+10000000001";
  assert.equal((await getDay(user)).goals.budget, 150);
  await logMeal(user, meal);
  await logMeal(user, { ...meal, name: "Naan", calories: 260, protein: 8, price: 4 });
  const day = await getDay(user);
  assert.equal(budgetLeft(day), 132);
  assert.equal(summary(day).remaining.budget_this_month, 132);
  assert.equal(totals(day).spent, 18);
});

test("a meal logged without a protein number can't turn the totals into NaN", async () => {
  const user = "+10000000002";
  await logMeal(user, { name: "Mystery plate", calories: 500, protein: undefined as unknown as number, price: 10 });
  await logMeal(user, meal);
  const t = totals(await getDay(user));
  assert.equal(t.protein, 52);
  assert.equal(t.calories, 1290);
  assert.ok(Object.values(t).every(Number.isFinite));
});

test("protein adds up across meals", async () => {
  const user = "+10000000003";
  await logMeal(user, meal);
  await logMeal(user, { ...meal, name: "Grilled chicken kabab", calories: 690, protein: 67 });
  assert.equal(totals(await getDay(user)).protein, 119);
});

test("a dish logged on pick isn't counted again when they say they ate it", async () => {
  const user = "+10000000004";
  const picked = await logMeal(user, meal, { auto: true });
  assert.equal(picked.added, true);
  const typed = await logMeal(user, { ...meal, name: "chicken tikka masala" });
  assert.equal(typed.added, false);
  const day = await getDay(user);
  assert.equal(day.meals.length, 1);
  assert.equal(totals(day).monthSpent, 14); // the price was only counted once
  // A different dish, or a typed meal with no pick behind it, is logged as usual.
  assert.equal((await logMeal(user, { ...meal, name: "Naan", price: 4 })).added, true);
});
