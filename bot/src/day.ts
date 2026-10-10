// Per-person daily tracking: goals + meals logged today. In memory for now.
import { createHash } from "node:crypto";

export type Goals = { calories: number; protein: number; budget: number };
export type Meal = { name: string; calories: number; protein: number; price: number; at: Date };
export type Day = { key: string; date: string; goals: Goals; meals: Meal[] };

const DEFAULT_GOALS: Goals = { calories: 2000, protein: 120, budget: 40 };
const days = new Map<string, Day>();
const goals = new Map<string, Goals>();

/** Opaque id for URLs so phone numbers never appear in links. */
export const keyFor = (userId: string) => createHash("sha256").update(userId).digest("hex").slice(0, 12);

const today = () => new Date().toLocaleDateString("en-CA"); // YYYY-MM-DD, local time

export function getDay(userId: string): Day {
  const key = keyFor(userId);
  let day = days.get(key);
  if (!day || day.date !== today()) {
    day = { key, date: today(), goals: goals.get(key) ?? { ...DEFAULT_GOALS }, meals: [] };
    days.set(key, day);
  }
  return day;
}

export const getDayByKey = (key: string) => days.get(key);

export function logMeal(userId: string, meal: Omit<Meal, "at">): Day {
  const day = getDay(userId);
  day.meals.push({ ...meal, at: new Date() });
  return day;
}

export function setGoals(userId: string, update: Partial<Goals>): Day {
  const day = getDay(userId);
  for (const [k, v] of Object.entries(update)) {
    if (typeof v === "number" && v > 0) day.goals[k as keyof Goals] = v;
  }
  goals.set(day.key, day.goals);
  return day;
}

export function totals(day: Day) {
  const sum = (f: (m: Meal) => number) => day.meals.reduce((a, m) => a + f(m), 0);
  return { calories: sum((m) => m.calories), protein: sum((m) => m.protein), spent: sum((m) => m.price) };
}

/** Compact summary handed back to Gemini after a tool call. */
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
