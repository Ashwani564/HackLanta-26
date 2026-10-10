import assert from "node:assert/strict";
import test from "node:test";
import { keyFor, logMeal, type Day } from "../../bot/src/day.js";
import {
  adjustedCalories, connectHealth, dayGoals, fromHealthAutoExport, getMetrics, handleHealthRequest, healthReply, healthSummary, pendingMeals,
  setPublicBase, setupPage, syncTokenFor,
  type HealthMetrics,
} from "../../bot/src/health.js";

// No STATE_TABLE here, so store.ts keeps everything in memory. Each test uses its own person.
let n = 0;
const person = () => `+1555000${String(++n).padStart(4, "0")}`;
const tick = () => new Promise((r) => setTimeout(r, 3)); // meal ids are timestamps; keep them apart

const call = (method: string, token: string, route: string, body?: unknown) =>
  handleHealthRequest(method, `/health/${token}/${route}`, body === undefined ? "" : JSON.stringify(body));
const mealsOf = (res: { body?: unknown }) => (res.body as { meals: { id: string; name: string }[] }).meals;

test("a person keeps one sync token, and it isn't derived from their number", async () => {
  const user = person();
  const token = await syncTokenFor(user);
  assert.equal(await syncTokenFor(user), token);
  assert.match(token, /^[A-Za-z0-9_-]{24}$/);
  assert.ok(!token.includes(keyFor(user)));
  assert.notEqual(await syncTokenFor(person()), token);
});

test("an unknown token is a 404, the same as an unknown path", async () => {
  const token = await syncTokenFor(person());
  assert.equal((await call("GET", "A".repeat(24), "pending")).status, 404);
  assert.equal((await call("GET", token, "everything")).status, 404);
  assert.equal((await handleHealthRequest("GET", "/health/")).status, 404);
  assert.equal((await call("POST", token, "pending")).status, 405);
  assert.equal((await call("GET", token, "ack")).status, 405);
});

test("meals logged in chat are pending until the phone acks them", async () => {
  const user = person();
  const token = await syncTokenFor(user);
  assert.deepEqual(mealsOf(await call("GET", token, "pending")), []);

  await logMeal(user, { name: "Burrito", calories: 900, protein: 45, price: 12 });
  await tick();
  await logMeal(user, { name: "Iced latte", calories: 190, protein: 10, price: 5.5 });
  const first = await call("GET", token, "pending");
  assert.equal(first.status, 200);
  const meals = mealsOf(first);
  assert.deepEqual(meals.map((m) => m.name), ["Burrito", "Iced latte"]);
  assert.deepEqual(meals[0], { id: meals[0]!.id, name: "Burrito", calories: 900, protein: 45, at: meals[0]!.id });

  assert.deepEqual((await call("POST", token, "ack", { ids: [meals[0]!.id] })).body, { acked: 1 });
  assert.deepEqual(mealsOf(await call("GET", token, "pending")).map((m) => m.name), ["Iced latte"]);

  // Acking again, or acking something that was never logged, changes nothing.
  assert.deepEqual((await call("POST", token, "ack", { ids: [meals[0]!.id, "2020-01-01T00:00:00.000Z"] })).body, { acked: 0 });

  await tick();
  await logMeal(user, { name: "Wings", calories: 600, protein: 40, price: 9 });
  assert.deepEqual(mealsOf(await call("GET", token, "pending")).map((m) => m.name), ["Iced latte", "Wings"]);
});

test("ack takes the ids as a list or as the newline-joined text Shortcuts sends", async () => {
  const user = person();
  const token = await syncTokenFor(user);
  await logMeal(user, { name: "A", calories: 1, protein: 1, price: 0 });
  await tick();
  await logMeal(user, { name: "B", calories: 1, protein: 1, price: 0 });
  const ids = mealsOf(await call("GET", token, "pending")).map((m) => m.id);
  assert.deepEqual((await call("POST", token, "ack", { ids: ids.join("\n") })).body, { acked: 2 });
  assert.deepEqual(await pendingMeals(keyFor(user)), []);

  // The same text wrapped in a list, and no meals at all (an empty text), are fine too.
  await tick();
  await logMeal(user, { name: "C", calories: 1, protein: 1, price: 0 });
  await tick();
  await logMeal(user, { name: "D", calories: 1, protein: 1, price: 0 });
  const more = mealsOf(await call("GET", token, "pending")).map((m) => m.id);
  assert.deepEqual((await call("POST", token, "ack", { ids: [more.join("\n")] })).body, { acked: 2 });
  assert.deepEqual((await call("POST", token, "ack", { ids: "" })).body, { acked: 0 });
  assert.equal((await call("POST", token, "ack", { ids: 5 })).status, 400);
  assert.equal((await handleHealthRequest("POST", `/health/${token}/ack`, "not json")).status, 400);
});

test("carbs and fat are sent when they were estimated, and left out (not zeroed) when they weren't", async () => {
  const user = person();
  const token = await syncTokenFor(user);
  await logMeal(user, { name: "Pad thai", calories: 700, protein: 25, carbs: 90, fat: 0, price: 13 });
  await tick();
  await logMeal(user, { name: "Mystery snack", calories: 150, protein: 3, price: 0 });
  const [full, bare] = mealsOf(await call("GET", token, "pending")) as Record<string, unknown>[];
  assert.equal(full!.carbs, 90);
  assert.equal(full!.fat, 0); // a real zero is kept
  assert.ok(!("carbs" in bare!) && !("fat" in bare!));
});

test("connecting Apple Health: off until configured, link only one-on-one, and never remembered", async () => {
  const user = person();
  delete process.env.HEALTH_SHORTCUT_URL;
  assert.deepEqual(await connectHealth(user, false), { error: "apple health sync isn't set up on this bot yet" });

  process.env.HEALTH_SHORTCUT_URL = "https://www.icloud.com/shortcuts/abc123";
  setPublicBase("https://bot.example.test/");
  const token = await syncTokenFor(user);

  // In a group nothing private is sent, whatever is configured.
  const group = await connectHealth(user, true);
  assert.ok("text" in group && !group.text.includes(token) && !group.text.includes("http"));

  const out = await connectHealth(user, false);
  assert.ok("text" in out);
  const bubbles = out.text.split("\n\n");
  assert.ok(bubbles.includes(`https://bot.example.test/health/${token}`), "the sync link is a bubble of its own");
  assert.equal(bubbles.length, 4, "short enough to read in a text thread");
  assert.ok(!out.said.includes(token) && !out.said.includes("http"), "history never holds the link");
  // The link that was sent is the one the phone can actually use.
  assert.equal((await handleHealthRequest("GET", new URL(bubbles.find((b) => b.includes("/health/"))!).pathname + "/pending")).status, 200);
});

test("one person's token never shows another person's meals", async () => {
  const a = person(), b = person();
  const tokenB = await syncTokenFor(b);
  await logMeal(a, { name: "Private lunch", calories: 500, protein: 30, price: 8 });
  assert.deepEqual(mealsOf(await call("GET", tokenB, "pending")), []);
});

test("metrics from the phone are stored as numbers, in kg, and garbage is rejected", async () => {
  const user = person();
  const token = await syncTokenFor(user);
  assert.equal(await getMetrics(keyFor(user)), undefined);

  assert.equal((await call("POST", token, "metrics", { active_kcal: "412.6", steps: 8042, weight_lb: 165 })).status, 200);
  const saved = await getMetrics(keyFor(user));
  assert.equal(saved?.activeKcal, 412.6);
  assert.equal(saved?.steps, 8042);
  assert.equal(saved?.weightKg, 74.8);

  assert.equal((await call("POST", token, "metrics", { active_kcal: "lots", steps: -5 })).status, 400);
  assert.equal((await call("POST", token, "metrics", [1, 2])).status, 400);
  assert.equal((await getMetrics(keyFor(user)))?.steps, 8042); // a rejected body doesn't wipe what was there
});

// ---------- using the numbers Health sent back ----------

const goals = { calories: 2000, protein: 120, budget: 40 };
const dayWith = (...meals: { calories: number; protein: number }[]): Day => ({
  key: "k", date: "2026-01-01", goals, meals: meals.map((m, i) => ({ name: `meal ${i}`, price: 0, at: `t${i}`, ...m })),
});
const burned = (activeKcal?: number, steps?: number): HealthMetrics => ({
  date: "2026-01-01", updatedAt: "now", ...(activeKcal !== undefined && { activeKcal }), ...(steps !== undefined && { steps }),
});

test("active calories add room to the day, but only half and never more than 500", () => {
  assert.equal(adjustedCalories(goals), 2000);
  assert.equal(adjustedCalories(goals, burned(undefined, 9000)), 2000);
  assert.equal(adjustedCalories(goals, burned(400)), 2200);
  assert.equal(adjustedCalories(goals, burned(3000)), 2500);
});

test("the model hears what was burned and what's left counting it, and nothing it wasn't sent", () => {
  const day = dayWith({ calories: 700, protein: 40 });
  assert.deepEqual(healthSummary(day, burned(412.6, 8042)), { active_calories_burned: 413, calories_left_counting_activity: 1506, steps: 8042 });
  assert.deepEqual(healthSummary(day, burned(undefined, 8042)), { steps: 8042 });
});

test("day hints: none until something is logged, lighter when calories run low, protein when behind", () => {
  assert.deepEqual(dayGoals(dayWith()), []); // nothing eaten yet is no signal, even with protein to go
  assert.deepEqual(dayGoals(dayWith({ calories: 400, protein: 30 })), []);
  assert.deepEqual(dayGoals(dayWith({ calories: 1700, protein: 110 })), ["low_cal"]);
  assert.deepEqual(dayGoals(dayWith({ calories: 1300, protein: 40 })), ["high_protein"]);
  assert.deepEqual(dayGoals(dayWith({ calories: 2100, protein: 60 })), ["low_cal", "high_protein"]);
});

test("a long walk can take the 'go lighter' hint away again", () => {
  const day = dayWith({ calories: 1700, protein: 110 });
  assert.deepEqual(dayGoals(day, burned(200)), ["low_cal"]); // 100 credited: 400 left
  assert.deepEqual(dayGoals(day, burned(1000)), []); // 500 credited: 800 left
});

// ---------- setup page and Health Auto Export ----------

test("opening the sync link in a browser shows the setup page, which never prints the token", async () => {
  const token = await syncTokenFor(person());
  process.env.HEALTH_SHORTCUT_URL = "https://www.icloud.com/shortcuts/abc123";
  const out = await handleHealthRequest("GET", `/health/${token}`);
  assert.equal(out.status, 200);
  assert.ok(out.html?.includes('href="https://www.icloud.com/shortcuts/abc123"'));
  assert.ok(out.html?.includes("Run Immediately"));
  assert.ok(!out.html?.includes(token), "the page reads the link from its own address instead");
  assert.equal((await handleHealthRequest("GET", `/health/${token}/`)).status, 200);
  assert.equal((await handleHealthRequest("POST", `/health/${token}`)).status, 405);
  assert.equal((await handleHealthRequest("GET", `/health/${"B".repeat(24)}`)).status, 404);

  const reply = healthReply(out);
  assert.ok(reply.headers["content-type"]!.startsWith("text/html"));
  assert.equal(reply.headers["referrer-policy"], "no-referrer"); // tapping the iCloud link must not leak this page's address
  assert.equal(reply.headers["cache-control"], "no-store");
  assert.equal(healthReply({ status: 200, body: { ok: true } }).text, '{"ok":true}');
});

test("the setup page only links to an https shortcut, and escapes it", async () => {
  assert.ok(setupPage(undefined).includes("hasn't been published"));
  assert.ok(setupPage('https://x.test/a"><script>alert(1)</script>').includes("&#34;&#62;&#60;script"));
  const token = await syncTokenFor(person());
  process.env.HEALTH_SHORTCUT_URL = "javascript:alert(1)";
  assert.ok(!(await handleHealthRequest("GET", `/health/${token}`)).html?.includes("javascript:"));
  process.env.HEALTH_SHORTCUT_URL = "https://www.icloud.com/shortcuts/abc123";
});

test("a Health Auto Export body becomes today's active calories and steps", () => {
  const point = (qty: number, date: string) => ({ qty, date });
  const body = { data: { workouts: [], metrics: [
    { name: "active_energy", units: "kcal", data: [point(300, "2026-10-09 00:00:00 -0400"), point(250.5, "2026-10-10 00:00:00 -0400"), point(100, "2026-10-10 12:00:00 -0400")] },
    { name: "step_count", units: "count", data: [point(8042, "2026-10-10 00:00:00 -0400")] },
    { name: "heart_rate", units: "bpm", data: [{ Avg: 70, date: "2026-10-10 00:00:00 -0400" }] },
  ] } };
  assert.deepEqual(fromHealthAutoExport(body, "2026-10-10"), { active_kcal: 350.5, steps: 8042 });
  assert.deepEqual(fromHealthAutoExport(body, "2026-10-11"), {}); // nothing for that day: no numbers, not zeros
  const kj = { data: { metrics: [{ name: "active_energy", units: "kJ", data: [point(4184, "2026-10-10 00:00:00 -0400")] }] } };
  assert.deepEqual(fromHealthAutoExport(kj, "2026-10-10"), { active_kcal: 1000 });
  assert.equal(fromHealthAutoExport({ active_kcal: 400 }), undefined); // the shortcut's own body is left alone
});

test("the metrics route takes a Health Auto Export body as it is", async () => {
  const user = person();
  const token = await syncTokenFor(user);
  const now = new Date().toLocaleDateString("en-CA", { timeZone: process.env.BOT_TIMEZONE ?? "America/New_York" });
  const body = { data: { metrics: [{ name: "active_energy", units: "kcal", data: [{ qty: 512, date: `${now} 00:00:00 -0400` }] }] } };
  assert.equal((await call("POST", token, "metrics", body)).status, 200);
  assert.equal((await getMetrics(keyFor(user)))?.activeKcal, 512);
  assert.equal((await call("POST", token, "metrics", { data: { metrics: [] } })).status, 400);
});
