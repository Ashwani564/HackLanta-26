// Apple Health bridge. Health has no cloud API, so a Shortcut on the person's iPhone calls these routes:
// it pulls the meals logged in chat (and writes them to Health), then pushes back a few numbers it read
// from Health. Each person gets an unguessable sync token; the token in the URL is the only credential,
// so it is never logged.
import { randomBytes } from "node:crypto";
import { getDayByKey, keyFor, today } from "./day.js";
import { getState, putState } from "./store.js";

export type PendingMeal = { id: string; name: string; calories: number; protein: number; at: string };
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
    .map((m) => ({ id: m.at, name: m.name, calories: m.calories, protein: m.protein, at: m.at }));
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
