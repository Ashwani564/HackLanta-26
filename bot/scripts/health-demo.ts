// Usage: tsx scripts/health-demo.ts
// Starts the local web server with two sample meals logged for a made-up person, and prints the sync
// link for the Apple Health shortcut (see "Apple Health sync" in the README). Press Enter to log another
// sample meal and see what the phone last sent from Health. Nothing leaves this machine; state is in
// memory, so the link changes on every start.
import { networkInterfaces } from "node:os";
import { createInterface } from "node:readline";
import { getDay, logMeal } from "../src/day.js";
import { dayGoals, getMetrics, healthSummary, syncTokenFor } from "../src/health.js";
import { startWeb } from "../src/web.js";

const user = "+15550001234";
const samples = [
  { name: "Greek yogurt bowl", calories: 380, protein: 28, carbs: 42, fat: 9, price: 6 },
  { name: "Chicken over rice", calories: 750, protein: 45, carbs: 78, fat: 26, price: 11 },
  { name: "Iced latte", calories: 190, protein: 10, carbs: 19, fat: 7, price: 5.5 },
  // No carbs or fat on this one, like a meal nobody estimated them for: the shortcut must skip those two.
  { name: "Protein bar", calories: 210, protein: 20, price: 3 },
  { name: "Burrito bowl", calories: 820, protein: 48, carbs: 88, fat: 28, price: 12 },
];
let next = 0;
const logNext = async () => {
  const meal = samples[next++ % samples.length]!;
  await logMeal(user, meal);
  const macros = meal.carbs === undefined ? "no carbs/fat" : `${meal.carbs}g carbs, ${meal.fat}g fat`;
  console.log(`logged: ${meal.name} (${meal.calories} cal, ${meal.protein}g protein, ${macros})`);
};

await logNext();
await new Promise((r) => setTimeout(r, 5));
await logNext();

const port = process.env.PORT ?? 8787;
const path = `/health/${await syncTokenFor(user)}`;
const local = `http://localhost:${port}${path}`;
// A phone on the same Wi-Fi reaches this machine by its LAN address, not localhost.
const lan = Object.values(networkInterfaces())
  .flat()
  .filter((n) => n?.family === "IPv4" && !n.internal)
  .map((n) => `http://${n!.address}:${port}${path}`);

startWeb();
console.log(`
sync link for the phone (same Wi-Fi). Open it in Safari for the setup page and a Copy button:
${lan.map((l) => `  ${l}`).join("\n") || "  (no network address found)"}

from this machine:
  curl ${local}/pending
  curl -X POST ${local}/ack -H "content-type: application/json" -d '{"ids":["<id from pending>"]}'
  curl -X POST ${local}/metrics -H "content-type: application/json" -d '{"active_kcal":412,"steps":8042,"weight_lb":165}'

press Enter to log another sample meal and show what Health sent, Ctrl+C to stop
`);
createInterface({ input: process.stdin }).on("line", async () => {
  await logNext();
  // What the read half of the shortcut has sent so far, and what the bot makes of it.
  const day = await getDay(user);
  const metrics = await getMetrics(day.key);
  console.log(metrics ? `from health: ${JSON.stringify(healthSummary(day, metrics))}` : "from health: nothing yet");
  console.log(`dish hints: ${dayGoals(day, metrics).join(", ") || "none"}`);
});
