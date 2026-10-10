// Apple Health bridge. Health has no cloud API, so a Shortcut on the person's iPhone calls these routes:
// it pulls the meals logged in chat (and writes them to Health), then pushes back a few numbers it read
// from Health. Each person gets an unguessable sync token; the token in the URL is the only credential,
// so it is never logged.
import { randomBytes } from "node:crypto";
import type { Goal } from "../../src/pipeline/parse.js";
import { baseUrl } from "./cards.js";
import { getDayByKey, keyFor, today, totals, type Day, type Goals } from "./day.js";
import { claimOnce, getState, putState } from "./store.js";

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
const ownerKey = (key: string) => `healthowner#${key}`;
const seenKey = (key: string) => `healthseen#${key}`;

/** The person's sync token, made on first use. Random on purpose: keyFor() is a hash of a phone number. */
export async function syncTokenFor(userId: string): Promise<string> {
  const key = keyFor(userId);
  const existing = await getState<string>(userKey(key));
  if (existing) return existing;
  const token = randomBytes(18).toString("base64url");
  await putState(tokenKey(token), key);
  await putState(ownerKey(key), userId); // so the bot can text them when their phone first syncs
  await putState(userKey(key), token);
  return token;
}

/** Note that the phone just synced. Returns who to tell, the one time this is their first sync ever. */
async function markSynced(key: string): Promise<string | undefined> {
  await putState(seenKey(key), new Date().toISOString());
  return (await claimOnce(`healthfirst#${key}`, 365 * 86400)) ? getState<string>(ownerKey(key)) : undefined;
}

// Where the phone reaches us. Set PUBLIC_URL locally; on Lambda the Function URL is learned from incoming
// requests and kept in the state table (cards.ts), since the function can't know its own URL up front.
let publicBase = process.env.PUBLIC_URL?.replace(/\/+$/, "");
export const setPublicBase = (url: string) => {
  publicBase ??= url.replace(/\/+$/, "");
};

/** The shared shortcut's iCloud link, if one has been published. Anything that isn't an https link counts as unset. */
const shortcutLink = () => {
  const url = process.env.HEALTH_SHORTCUT_URL?.trim();
  return url?.startsWith("https://") ? url : undefined;
};

/**
 * The setup texts, one paragraph per bubble. The person's sync link doubles as their setup page (opened in
 * a browser it shows the steps), so that one link, in a bubble of its own, is all they need.
 */
export function connectText(syncLink: string): string {
  return [
    "ok let's hook me up to apple health, takes a minute",
    "open this and follow the steps. it's your private link, so don't pass it on",
    syncLink,
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
  const base = publicBase ?? (await baseUrl());
  if (!shortcutLink() || !base) return { error: "apple health sync isn't set up on this bot yet" };
  return {
    text: connectText(`${base}/health/${await syncTokenFor(userId)}`),
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

/** `html` is set for the setup page; everything else answers with `body` as JSON. `route` is for the log line. */
export type HealthResponse = { status: number; body?: unknown; html?: string; route?: string };

const ROUTE = /^\/health\/([A-Za-z0-9_-]{16,64})(?:\/(pending|ack|metrics|status))?\/?$/;
const METHODS = { setup: "GET", status: "GET", pending: "GET", ack: "POST", metrics: "POST" } as const;

type Route = keyof typeof METHODS;

/** Who is asking (from the request headers), and what the routes can set off that needs the running bot. */
export type HealthContext = { accept?: string; userAgent?: string; onFirstSync?: (userId: string) => Promise<unknown> | unknown };

// A browser asks for HTML and calls itself Mozilla; the Shortcuts app does neither. With no headers at all
// (a direct call) the bare link stays the page.
const isBrowser = (c: HealthContext) =>
  (c.accept === undefined && c.userAgent === undefined) || /text\/html/i.test(c.accept ?? "") || /mozilla/i.test(c.userAgent ?? "");

export const isHealthPath = (path: string) => path.startsWith("/health/");

/** Status, headers and text for either kind of answer. Nothing here may be cached, indexed or leaked by a referrer. */
export function healthReply(out: HealthResponse): { status: number; headers: Record<string, string>; text: string } {
  const common = { "cache-control": "no-store", "referrer-policy": "no-referrer", "x-robots-tag": "noindex" };
  return out.html !== undefined
    ? { status: out.status, headers: { ...common, "content-type": "text/html; charset=utf-8" }, text: out.html }
    : { status: out.status, headers: { ...common, "content-type": "application/json" }, text: JSON.stringify(out.body) };
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** Sent by the bot the first time someone's phone syncs. */
export const CONNECTED_TEXT = "ok you're connected. whatever you log with me shows up in apple health now";

/**
 * The page a person sees when they open their sync link in a browser. The link itself is filled in by the
 * page from its own address, so the server never has to know (or print) where it is being served from.
 * The buttons run the shortcut by name, so the shared shortcut has to stay named "Pie Sync".
 * Plain system type, square corners, hairlines, and it follows the phone's light or dark setting.
 */
export function setupPage(shortcutUrl: string | undefined): string {
  const add = shortcutUrl
    ? `<p>When Shortcuts asks for your link, touch and hold the field, tap Paste, then tap Add Shortcut.</p>
<a class="btn" id="add" href="${esc(shortcutUrl)}">Add Pie Sync</a>`
    : `<p>The shortcut hasn't been published for this bot yet.</p>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="color-scheme" content="light dark">
<meta name="robots" content="noindex"><meta name="referrer" content="no-referrer"><title>Connect Apple Health</title><style>
:root{--bg:#fff;--text:#1d1d1f;--muted:#6e6e73;--line:#d2d2d7;--field:#f5f5f7;--link:#0066cc;--ok:#248a3d;--warn:#b25000}
@media (prefers-color-scheme:dark){:root{--bg:#000;--text:#f5f5f7;--muted:#a1a1a6;--line:#424245;--field:#1d1d1f;--link:#2997ff;--ok:#30d158;--warn:#ff9f0a}}
*{box-sizing:border-box;border-radius:0}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--text);font:17px/1.47 -apple-system,BlinkMacSystemFont,"SF Pro Text","Helvetica Neue",Helvetica,Arial,sans-serif;-webkit-font-smoothing:antialiased;-webkit-tap-highlight-color:transparent}
main{max-width:560px;margin:0 auto;padding:56px 24px calc(48px + env(safe-area-inset-bottom))}
h1{margin:0 0 12px;font-size:34px;line-height:1.12;font-weight:700;letter-spacing:-.022em}
.lede{margin:0 0 40px;font-size:19px;line-height:1.42;letter-spacing:-.01em}
section{display:grid;grid-template-columns:28px minmax(0,1fr);padding:28px 0;border-top:1px solid var(--line)}
section:last-of-type{border-bottom:1px solid var(--line)}
.n{font-size:19px;line-height:1.26;font-weight:600;color:var(--muted);font-variant-numeric:tabular-nums}
h2{margin:0 0 6px;font-size:19px;line-height:1.26;font-weight:600;letter-spacing:-.012em}
h2 span{margin-left:6px;font-weight:400;color:var(--muted)}
p{margin:0;color:var(--muted);font-size:15px;line-height:1.47}
.btn{display:block;width:100%;margin:16px 0 0;padding:14px 20px;border:1px solid var(--text);background:var(--text);color:var(--bg);font:inherit;font-size:17px;font-weight:500;line-height:1.2;text-align:center;text-decoration:none;cursor:pointer;-webkit-appearance:none;appearance:none}
.btn:active{opacity:.7}
.btn.done{background:transparent;color:var(--text)}
.more{display:inline-block;margin-top:14px;color:var(--link);font-size:17px;text-decoration:none}
input{display:block;width:100%;margin:12px 0 0;padding:12px;border:1px solid var(--line);background:var(--field);color:var(--text);font:13px/1.3 ui-monospace,"SF Mono",SFMono-Regular,Menlo,monospace;-webkit-appearance:none;appearance:none}
#copyhelp{margin-top:10px}
ol{margin:14px 0 0;padding:0;list-style:none;border-top:1px solid var(--line)}
ol li{padding:11px 0;border-bottom:1px solid var(--line);font-size:15px}
#status{display:flex;align-items:baseline;gap:10px;margin-top:16px;font-size:15px;color:var(--muted)}
#status::before{content:"";flex:none;width:8px;height:8px;background:var(--line)}
#status.ok{color:var(--text)}
#status.ok::before{background:var(--ok)}
#status.warn::before{background:var(--warn)}
.foot{margin-top:28px;font-size:13px}
</style></head><body><main>
<h1>Connect Apple Health</h1>
<p class="lede">Meals you log in chat appear in Health. Setup takes about a minute.</p>
<section><div class="n">1</div><div>
<h2>Copy your link</h2>
<p>You'll paste it in the next step.</p>
<button class="btn" id="copy" type="button">Copy Link</button>
<input id="link" readonly aria-label="Your private link">
<p id="copyhelp" hidden>Touch and hold the link, then tap Copy.</p>
</div></section>
<section><div class="n">2</div><div>
<h2>Add the shortcut</h2>
${add}
</div></section>
<section><div class="n">3</div><div>
<h2>Run it once</h2>
<p>Allow the connection and access to Health when asked, then return to this page.</p>
<a class="btn" id="run" href="shortcuts://run-shortcut?name=Pie%20Sync">Test It</a>
<div id="status" role="status">Not connected</div>
</div></section>
<section><div class="n">4</div><div>
<h2>Sync automatically<span>Optional</span></h2>
<p>Add an automation so Health updates each time the bot texts you. Without it, tap Sync Now on this page anytime.</p>
<ol><li>Open Shortcuts and tap Automation</li><li>Tap New Automation, then Message</li><li>For Sender, choose the bot</li><li>Select Run Immediately</li><li>Choose Pie Sync</li></ol>
<a class="more" href="shortcuts://">Open Shortcuts ›</a>
</div></section>
<p class="foot">This link is private to you. Don't share it.</p>
</main><script>
const path = location.pathname.endsWith("/") ? location.pathname.slice(0, -1) : location.pathname;
const link = location.origin + path;
const $ = (id) => document.getElementById(id);
$("link").value = link;
// Copying is its own step, and says whether it worked: a copy that fails quietly means the wrong thing
// gets pasted into the shortcut, which then calls the wrong address.
const copy = async () => {
  try { await navigator.clipboard.writeText(link); return true; } catch {}
  const box = $("link");
  let ok = false;
  box.readOnly = false; box.focus(); box.setSelectionRange(0, link.length);
  try { ok = document.execCommand("copy"); } catch {}
  box.readOnly = true; box.blur();
  return ok;
};
$("copy").onclick = async () => {
  const ok = await copy();
  $("copy").textContent = ok ? "Copied" : "Couldn't Copy";
  $("copy").classList.toggle("done", ok);
  $("copyhelp").hidden = ok;
};

// After a test, keep asking the server whether the phone has synced, for a couple of minutes.
let tapped = 0, pollUntil = Date.now() + 120000;
const say = (text, state) => { $("status").textContent = text; $("status").className = state; };
const check = async () => {
  try {
    const s = await (await fetch(path + "/status", { cache: "no-store" })).json();
    if (s.synced_at) {
      const at = new Date(s.synced_at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
      say("Connected. Last synced " + at + ".", "ok");
      $("run").textContent = "Sync Now";
    } else if (tapped && Date.now() - tapped > 15000) {
      say("Nothing came through. If Shortcuts showed an error, your link wasn't pasted in: copy it in step 1, open Pie Sync in Shortcuts to edit it, clear the first field and paste. Then try again.", "warn");
    }
  } catch {}
};
$("run").onclick = () => {
  tapped = Date.now(); pollUntil = tapped + 120000;
  if ($("status").className !== "ok") say("Waiting for your iPhone…", "");
};
document.addEventListener("visibilitychange", () => { if (!document.hidden) { pollUntil = Date.now() + 120000; check(); } });
setInterval(() => { if (!document.hidden && Date.now() < pollUntil) check(); }, 3000);
check();
</script></body></html>`;
}

/**
 * Health Auto Export (an App Store app) can POST Health data to a URL on a schedule, as
 * { data: { metrics: [{ name, units, data: [{ qty, date: "2024-02-06 14:30:00 -0800" }] }] } }.
 * Turns that into the fields the shortcut sends (today's active energy and steps, summed), or returns
 * undefined when the body isn't in that shape.
 */
export function fromHealthAutoExport(body: Record<string, unknown>, day = today()): Record<string, unknown> | undefined {
  const metrics = (body.data as { metrics?: unknown } | undefined)?.metrics;
  if (!Array.isArray(metrics)) return undefined;
  const sumToday = (name: string): { total: number; units: string } | undefined => {
    const metric = metrics.find((m) => m?.name === name);
    // Dates are in the phone's own time zone, so the day is simply the front of the string.
    const points = (Array.isArray(metric?.data) ? metric.data : []).filter(
      (p: any) => typeof p?.date === "string" && p.date.startsWith(day) && typeof p.qty === "number" && Number.isFinite(p.qty),
    );
    return points.length > 0 ? { total: points.reduce((a: number, p: any) => a + p.qty, 0), units: String(metric.units ?? "") } : undefined;
  };
  const energy = sumToday("active_energy");
  const steps = sumToday("step_count");
  return {
    ...(energy && { active_kcal: /^kj$/i.test(energy.units) ? energy.total / 4.184 : energy.total }),
    ...(steps && { steps: steps.total }),
  };
}

/**
 *   GET  /health/<token>           -> the setup page (HTML), for a browser
 *   GET  /health/<token>/status    -> { synced_at } (when the phone last synced; the setup page polls this)
 *   GET  /health/<token>/pending   -> { meals: [{ id, name, calories, protein, carbs?, fat?, at }] }
 *   POST /health/<token>/ack       { ids: [...] }                              -> { acked: n }
 *   POST /health/<token>/metrics   { active_kcal, steps, weight_kg | weight_lb } -> { ok: true }
 *                                  (or a Health Auto Export body, see fromHealthAutoExport)
 * An unknown token looks exactly like an unknown path.
 *
 * The bare link also works as the sync address for anything that isn't a browser. When the link pasted into
 * the shortcut has a stray space or newline after it, Shortcuts keeps only the link and drops the "/pending"
 * the shortcut adds; it would then be handed the HTML page and fail with "couldn't convert from Rich Text to
 * Dictionary". So a non-browser GET on the bare link is read as "what's pending", and a POST by its body:
 * `ids` means an ack, anything else is the Health numbers.
 */
export async function handleHealthRequest(method: string, path: string, rawBody = "", ctx: HealthContext = {}): Promise<HealthResponse> {
  const match = path.split("?")[0]!.match(ROUTE);
  const key = match ? await getState<string>(tokenKey(match[1]!)) : undefined;
  if (!match || !key) return { status: 404, body: { error: "not found" }, route: "unknown link" };
  const verb = method.toUpperCase();

  let fields: Record<string, unknown> | undefined;
  if (verb === "POST") {
    try {
      const body: unknown = JSON.parse(rawBody);
      if (typeof body === "object" && body !== null && !Array.isArray(body)) fields = body as Record<string, unknown>;
    } catch {
      // left undefined: answered below as a bad request
    }
  }

  let route = (match[2] ?? "setup") as Route;
  const bare = route === "setup" && !isBrowser(ctx);
  if (bare && verb === "GET") route = "pending";
  if (bare && verb === "POST") route = fields && "ids" in fields ? "ack" : "metrics";
  const answer = (status: number, rest: { body?: unknown; html?: string }): HealthResponse => ({ status, ...rest, route: bare ? `${route} via the bare link` : route });

  if (verb !== METHODS[route]) return answer(405, { body: { error: `use ${METHODS[route]}` } });
  if (route === "setup") return answer(200, { html: setupPage(shortcutLink()) });
  if (route === "status") return answer(200, { body: { synced_at: (await getState<string>(seenKey(key))) ?? null } });
  if (route === "pending") {
    const meals = await pendingMeals(key);
    const newcomer = await markSynced(key);
    // Telling them is a nicety; it must never get in the way of the sync itself.
    if (newcomer) await Promise.resolve(ctx.onFirstSync?.(newcomer)).catch((err) => console.warn("first-sync notice failed:", err?.message ?? err));
    return answer(200, { body: { meals } });
  }

  if (!fields) return answer(400, { body: { error: "expected a JSON object" } });
  if (route === "ack") {
    // A Shortcuts list can arrive as one newline-joined text, or as a list holding such a text, instead of a plain list.
    const ids = typeof fields.ids === "string" ? [fields.ids] : fields.ids;
    if (!Array.isArray(ids)) return answer(400, { body: { error: "ids must be a list" } });
    const clean = ids.filter((id): id is string => typeof id === "string").flatMap((id) => id.split("\n")).map((id) => id.trim()).filter(Boolean);
    return answer(200, { body: { acked: await ackMeals(key, clean) } });
  }
  return (await saveMetrics(key, fromHealthAutoExport(fields) ?? fields))
    ? answer(200, { body: { ok: true } })
    : answer(400, { body: { error: "no usable numbers (active_kcal, steps, weight_kg or weight_lb)" } });
}
