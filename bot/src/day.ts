// Per-person daily tracking: goals + meals logged today, persisted via store.ts
// (DynamoDB in Lambda, in-memory locally).
import { createHash } from "node:crypto";
import { getState, putState } from "./store.js";

export type Goals = { calories: number; protein: number; budget: number };
// carbs and fat are only sent on to Apple Health; they're missing when nobody estimated them.
export type Meal = { name: string; calories: number; protein: number; carbs?: number; fat?: number; price: number; at: string };
export type Day = { key: string; date: string; goals: Goals; meals: Meal[] };

const DEFAULT_GOALS: Goals = { calories: 2000, protein: 120, budget: 40 };
// Days roll over at local midnight for the demo city, not the server's (Lambda runs in UTC).
export const TIME_ZONE = process.env.BOT_TIMEZONE ?? "America/New_York";
const DAY_TTL = 3 * 86400;

/** Opaque id for URLs so phone numbers never appear in links. */
export const keyFor = (userId: string) => createHash("sha256").update(userId).digest("hex").slice(0, 12);

export const today = () => new Date().toLocaleDateString("en-CA", { timeZone: TIME_ZONE }); // YYYY-MM-DD

export async function getDay(userId: string): Promise<Day> {
  return (await getDayByKey(keyFor(userId))) ?? freshDay(keyFor(userId));
}

export async function getDayByKey(key: string): Promise<Day | undefined> {
  const day = await getState<Day>(`day#${key}`);
  return day?.date === today() ? day : undefined;
}

async function freshDay(key: string): Promise<Day> {
  const goals = (await getState<Goals>(`goals#${key}`)) ?? { ...DEFAULT_GOALS };
  return { key, date: today(), goals, meals: [] };
}

export async function logMeal(userId: string, meal: Omit<Meal, "at">): Promise<Day> {
  const day = await getDay(userId);
  day.meals.push({ ...meal, at: new Date().toISOString() });
  await putState(`day#${day.key}`, day, DAY_TTL);
  return day;
}

export async function setGoals(userId: string, update: Partial<Goals>): Promise<Day> {
  const day = await getDay(userId);
  for (const [k, v] of Object.entries(update)) {
    if (typeof v === "number" && v > 0) day.goals[k as keyof Goals] = v;
  }
  await putState(`goals#${day.key}`, day.goals);
  await putState(`day#${day.key}`, day, DAY_TTL);
  return day;
}

export function totals(day: Day) {
  const sum = (f: (m: Meal) => number) => day.meals.reduce((a, m) => a + f(m), 0);
  return { calories: sum((m) => m.calories), protein: sum((m) => m.protein), spent: sum((m) => m.price) };
}

/** Compact summary handed back to the model after a tool call. */
export function summary(day: Day) {
  const t = totals(day);
  return {
    eaten: t,
    goals: day.goals,
    remaining: {
      calories: day.goals.calories - t.calories,
      protein: day.goals.protein - t.protein,
      budget: +(day.goals.budget - t.spent).toFixed(2),
    },
    meals: day.meals.map((m) => m.name),
  };
}
