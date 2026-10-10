// Per-person daily tracking: goals + meals logged today, persisted via store.ts
// (DynamoDB in Lambda, in-memory locally).
import { createHash } from "node:crypto";
import { getState, putState } from "./store.js";

export type Goals = { calories: number; protein: number; budget: number };
// carbs and fat are only sent on to Apple Health; they're missing when nobody estimated them.
export type Meal = {
  name: string;
  calories: number;
  protein: number;
  carbs?: number;
  fat?: number;
  price: number;
  at: string;
  /** Logged by the bot when they picked this dish, not typed by them: a later "i ate it" doesn't count it twice. */
  auto?: boolean;
};
/** `goals.budget` is a monthly budget; `monthSpent` is what's been logged so far this month (filled in on every load). */
export type Day = { key: string; date: string; goals: Goals; meals: Meal[]; monthSpent?: number };

const DEFAULT_GOALS: Goals = { calories: 2000, protein: 120, budget: 150 };
// Days roll over at local midnight for the demo city, not the server's (Lambda runs in UTC).
export const TIME_ZONE = process.env.BOT_TIMEZONE ?? "America/New_York";
const DAY_TTL = 3 * 86400;
const MONTH_TTL = 45 * 86400;
const AUTO_DEDUPE_MS = 30 * 60_000;

/** A number the card can show: the model sometimes leaves a field out, and one missing value must not turn a total into NaN. */
const finite = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** Opaque id for URLs so phone numbers never appear in links. */
export const keyFor = (userId: string) => createHash("sha256").update(userId).digest("hex").slice(0, 12);

export const today = () => new Date().toLocaleDateString("en-CA", { timeZone: TIME_ZONE }); // YYYY-MM-DD
const thisMonth = () => today().slice(0, 7); // YYYY-MM
const monthKey = (key: string) => `month#${key}#${thisMonth()}`;

export async function getDay(userId: string): Promise<Day> {
  return (await getDayByKey(keyFor(userId))) ?? freshDay(keyFor(userId));
}

export async function getDayByKey(key: string): Promise<Day | undefined> {
  const day = await getState<Day>(`day#${key}`);
  return day?.date === today() ? { ...day, monthSpent: await monthSpent(key) } : undefined;
}

async function freshDay(key: string): Promise<Day> {
  const goals = (await getState<Goals>(`goals#${key}`)) ?? { ...DEFAULT_GOALS };
  return { key, date: today(), goals, meals: [], monthSpent: await monthSpent(key) };
}

const monthSpent = async (key: string) => finite(await getState<number>(monthKey(key)));

/**
 * Add a meal to today (and its price to this month's spending). `auto` marks a dish logged because they picked it:
 * if they then also say "i ate it", the typed one isn't counted a second time. Returns `added: false` for that repeat.
 */
export async function logMeal(userId: string, meal: Omit<Meal, "at">, opts: { auto?: boolean } = {}): Promise<Day & { added: boolean }> {
  const day = await getDay(userId);
  const clean: Meal = {
    ...meal,
    calories: finite(meal.calories),
    protein: finite(meal.protein),
    price: finite(meal.price),
    ...(opts.auto && { auto: true }),
    at: new Date().toISOString(),
  };
  const same = (m: Meal) => m.name.trim().toLowerCase() === clean.name.trim().toLowerCase();
  const already = day.meals.some((m) => same(m) && (opts.auto || m.auto) && Date.now() - new Date(m.at).getTime() < AUTO_DEDUPE_MS);
  if (already) return { ...day, added: false };
  day.meals.push(clean);
  const spent = (day.monthSpent ?? 0) + clean.price;
  await putState(monthKey(day.key), spent, MONTH_TTL);
  await putState(`day#${day.key}`, day, DAY_TTL);
  return { ...day, monthSpent: spent, added: true };
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
  const sum = (f: (m: Meal) => number) => day.meals.reduce((a, m) => a + finite(f(m)), 0);
  return { calories: sum((m) => m.calories), protein: sum((m) => m.protein), spent: sum((m) => m.price), monthSpent: finite(day.monthSpent) };
}

/** What's left of the monthly budget. */
export const budgetLeft = (day: Day) => day.goals.budget - totals(day).monthSpent;

/** Compact summary handed back to the model after a tool call. */
export function summary(day: Day) {
  const t = totals(day);
  return {
    eaten: t,
    goals: day.goals,
    remaining: {
      calories: day.goals.calories - t.calories,
      protein: day.goals.protein - t.protein,
      budget_this_month: +(day.goals.budget - t.monthSpent).toFixed(2),
    },
    meals: day.meals.map((m) => m.name),
  };
}
