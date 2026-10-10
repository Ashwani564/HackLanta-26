// Apple Health bridge. Health has no cloud API, so a Shortcut on the person's iPhone calls these routes:
// it pulls the meals logged in chat (and writes them to Health), then pushes back a few numbers it read
// from Health. Each person gets an unguessable sync token; the token in the URL is the only credential,
// so it is never logged.
import { randomBytes } from "node:crypto";
import type { Goal } from "../../src/pipeline/parse.js";
import { getDayByKey, keyFor, today, totals, type Day, type Goals } from "./day.js";
import { getState, putState } from "./store.js";

export type PendingMeal = { id: string; name: string; calories: number; protein: number; carbs?: number; fat?: number; at: string };
export type HealthMetrics = { date: string; activeKcal?: number; steps?: number; weightKg?: number; updatedAt: string };
type Synced = { date: string; ids: string[] };

const SYNCED_TTL = 3 * 86400;
// Numbers only, and not kept around: this is the only Health data the bot stores.
const METRICS_TTL = 2 * 86400;
const LB_TO_KG = 0.45359237;

const tokenKey = (token: string) => `healthtoken#${token}`;
const userKey = (key: string) => `healthuser#${key}`;
const syncedKey = (key: string) => `healthsynced#${key}`;
const metricsKey = (key: string) => `health#${key}`;

/** The person's sync token, made on first use. Random on purpose: keyFor() is a hash of a phone number. */
export async function syncTokenFor(userId: string): Promise<string> {
  const key = keyFor(userId);
  const existing = await getState<string>(userKey(key));
  if (existing) return existing;
  const token = randomBytes(18).toString("base64url");
  await putState(tokenKey(token), key);
  await putState(userKey(key), token);
  return token;
}

// Where the phone reaches us. Set PUBLIC_URL locally; Lambda has no way to know its own Function URL up
// front, so it learns it from the first webhook that arrives (lambda.ts).
let publicBase = process.env.PUBLIC_URL?.replace(/\/+$/, "");
export const setPublicBase = (url: string) => {
  publicBase ??= url.replace(/\/+$/, "");
};

/** The setup texts, one paragraph per bubble. The sync link gets a bubble to itself so it's easy to copy. */
export function connectText(shortcutUrl: string, syncLink: string): string {
  return [
    "ok let's hook me up to apple health, takes a minute",
    `add this shortcut first: ${shortcutUrl}`,
    "when it asks for your link, paste this one. it's private to you, don't share it",
    syncLink,
    "last thing so it runs by itself: shortcuts app, automation tab, new automation, message, pick me as the sender, run immediately, then choose pie sync",
    "after that whatever you log with me shows up in health",
  ].join("\n\n");
}

/**
 * What to send when someone asks to connect Apple Health. The sync link is a credential, so it only ever
 * goes to a one-on-one chat; in a group the person is asked to message the bot directly. `said` is what
 * the chat history (and so the model) remembers, which never includes the link.
 */
export async function connectHealth(userId: string, inGroup: boolean): Promise<{ text: string; said: string } | { error: string }> {
  if (inGroup) {
    const text = "dm me and i'll set that up, the link is just for you";
    return { text, said: text };
  }
  const shortcutUrl = process.env.HEALTH_SHORTCUT_URL;
  if (!shortcutUrl || !publicBase) return { error: "apple health sync isn't set up on this bot yet" };
  return {
    text: connectText(shortcutUrl, `${publicBase}/health/${await syncTokenFor(userId)}`),
    said: "(sent the apple health setup steps and their private sync link)",
  };
}

const syncedIds = async (key: string, date: string) => {
  const synced = await getState<Synced>(syncedKey(key));
  return synced?.date === date ? synced.ids : [];
};

/** Today's meals that haven't been written to Health yet. A meal's id is the moment it was logged. */
export async function pendingMeals(key: string): Promise<PendingMeal[]> {
  const day = await getDayByKey(key);
  if (!day) return [];
  const done = new Set(await syncedIds(key, day.date));
  return day.meals
    .filter((m) => !done.has(m.at))
    .map((m) => ({
      id: m.at, name: m.name, calories: m.calories, protein: m.protein,
      // Left out when unknown, so the shortcut skips them instead of writing a made-up zero to Health.
      ...(m.carbs !== undefined && { carbs: m.carbs }),
      ...(m.fat !== undefined && { fat: m.fat }),
      at: m.at,
    }));
}

/**
 * Mark meals as written to Health. Kept in its own item (not on the day) so it never races logMeal rewriting
 * the day. Ids that aren't today's meals are ignored. Returns how many were newly marked.
 */
export async function ackMeals(key: string, ids: readonly string[]): Promise<number> {
  const day = await getDayByKey(key);
  if (!day) return 0;
  const done = await syncedIds(key, day.date);
  const logged = new Set(day.meals.map((m) => m.at));
  const fresh = [...new Set(ids)].filter((id) => logged.has(id) && !done.includes(id));
  if (fresh.length > 0) await putState(syncedKey(key), { date: day.date, ids: [...done, ...fresh] } satisfies Synced, SYNCED_TTL);
  return fresh.length;
}

// Shortcuts often sends numbers as text ("512.3"), so both are accepted. Anything else, or out of range, is dropped.
const num = (v: unknown, max: number): number | undefined => {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= max ? n : undefined;
};

/** Store what the phone read from Health today. Returns undefined when the body has no usable number. */
export async function saveMetrics(key: string, body: Record<string, unknown>): Promise<HealthMetrics | undefined> {
  const activeKcal = num(body.active_kcal, 20_000);
  const steps = num(body.steps, 200_000);
  // Health hands back weight in the person's own unit, so the shortcut may send either.
  const lb = num(body.weight_lb, 1100);
  const weightKg = num(body.weight_kg, 500) || (lb ? +(lb * LB_TO_KG).toFixed(1) : undefined);
  if (activeKcal === undefined && steps === undefined && !weightKg) return undefined;
  const metrics: HealthMetrics = {
    date: today(),
    ...(activeKcal !== undefined && { activeKcal }),
    ...(steps !== undefined && { steps }),
    ...(weightKg && { weightKg }),
    updatedAt: new Date().toISOString(),
  };
  await putState(metricsKey(key), metrics, METRICS_TTL);
  return metrics;
}

/** Today's numbers from Health, if the phone has synced today. */
export async function getMetrics(key: string): Promise<HealthMetrics | undefined> {
  const metrics = await getState<HealthMetrics>(metricsKey(key));
  return metrics?.date === today() ? metrics : undefined;
}

// ---------- using the numbers Health sent back ----------

// How much of the day's active calories counts as extra room to eat. Watches run high and a daily target
// already assumes ordinary moving around, so half is credited and never more than MAX_ACTIVE_CREDIT.
const ACTIVE_CREDIT = 0.5;
const MAX_ACTIVE_CREDIT = 500;
// Below this many calories left, lighter dishes are nudged up (a typical meal here runs 600-900).
const LIGHT_BELOW_KCAL = 600;
// "Behind on protein": at least this many grams still to go, making up this share of the calories left.
const PROTEIN_GAP_G = 20;
const PROTEIN_GAP_SHARE = 0.3;

/** The day's calorie target with part of the active calories from Health added back. */
export function adjustedCalories(goals: Goals, metrics?: HealthMetrics): number {
  return Math.round(goals.calories + Math.min(MAX_ACTIVE_CREDIT, (metrics?.activeKcal ?? 0) * ACTIVE_CREDIT));
}

/** What the model hears about Health after a day tool. Only ever built for a one-on-one chat. */
export function healthSummary(day: Day, metrics: HealthMetrics) {
  return {
    ...(metrics.activeKcal !== undefined && {
      active_calories_burned: Math.round(metrics.activeKcal),
      calories_left_counting_activity: adjustedCalories(day.goals, metrics) - Math.round(totals(day).calories),
    }),
    ...(metrics.steps !== undefined && { steps: Math.round(metrics.steps) }),
  };
}

/**
 * Soft ranking hints from how the person's day is going. Empty until they've logged something today (with
 * nothing eaten there's nothing to go on). These only reorder dishes that already passed the hard filters.
 */
export function dayGoals(day: Day, metrics?: HealthMetrics): Goal[] {
  if (day.meals.length === 0) return [];
  const eaten = totals(day);
  const left = adjustedCalories(day.goals, metrics) - eaten.calories;
  const proteinLeft = day.goals.protein - eaten.protein;
  const goals: Goal[] = [];
  if (left < LIGHT_BELOW_KCAL) goals.push("low_cal");
  if (proteinLeft >= PROTEIN_GAP_G && proteinLeft * 4 >= PROTEIN_GAP_SHARE * Math.max(left, 0)) goals.push("high_protein");
  return goals;
}

// ---------- HTTP routes (shared by the local web server and the Lambda Function URL) ----------

export type HealthResponse = { status: number; body: unknown };

const ROUTE = /^\/health\/([A-Za-z0-9_-]{16,64})\/(pending|ack|metrics)\/?$/;
const METHODS = { pending: "GET", ack: "POST", metrics: "POST" } as const;

export const isHealthPath = (path: string) => path.startsWith("/health/");

/**
 *   GET  /health/<token>/pending   -> { meals: [{ id, name, calories, protein, at }] }
 *   POST /health/<token>/ack       { ids: [...] }                              -> { acked: n }
 *   POST /health/<token>/metrics   { active_kcal, steps, weight_kg | weight_lb } -> { ok: true }
 * An unknown token looks exactly like an unknown path.
 */
export async function handleHealthRequest(method: string, path: string, rawBody = ""): Promise<HealthResponse> {
  const match = path.split("?")[0]!.match(ROUTE);
  const key = match ? await getState<string>(tokenKey(match[1]!)) : undefined;
  if (!match || !key) return { status: 404, body: { error: "not found" } };
  const route = match[2] as keyof typeof METHODS;
  if (method.toUpperCase() !== METHODS[route]) return { status: 405, body: { error: `use ${METHODS[route]}` } };
  if (route === "pending") return { status: 200, body: { meals: await pendingMeals(key) } };

  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    body = undefined;
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) return { status: 400, body: { error: "expected a JSON object" } };
  const fields = body as Record<string, unknown>;

  if (route === "ack") {
    // A Shortcuts list can arrive as one newline-joined text, or as a list holding such a text, instead of a plain list.
    const ids = typeof fields.ids === "string" ? [fields.ids] : fields.ids;
    if (!Array.isArray(ids)) return { status: 400, body: { error: "ids must be a list" } };
    const clean = ids.filter((id): id is string => typeof id === "string").flatMap((id) => id.split("\n")).map((id) => id.trim()).filter(Boolean);
    return { status: 200, body: { acked: await ackMeals(key, clean) } };
  }
  return (await saveMetrics(key, fields))
    ? { status: 200, body: { ok: true } }
    : { status: 400, body: { error: "no usable numbers (active_kcal, steps, weight_kg or weight_lb)" } };
}
