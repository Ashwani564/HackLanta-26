// Usage: tsx --env-file=.env scripts/plan-demo.ts +15551234567 [--render-only]
// Sends a "Tonight's plan" card, simulates votes coming in, then locks the winner.
import { writeFileSync } from "node:fs";
import { Spectrum } from "spectrum-ts";
import { imessage } from "spectrum-ts/providers/imessage";
import { type Plan, planJpeg, sendPlanCard } from "../src/plan.js";

const [to, flag] = process.argv.slice(2);

const plan: Plan = {
  id: `demo-${Date.now()}`,
  question: "Where are we eating tonight?",
  voters: 4,
  options: [
    { name: "Velvet Taco", detail: "Veg options · ~$14 · 0.4 mi", votes: 0 },
    { name: "Cava", detail: "High protein · ~$13 · 0.6 mi", votes: 0 },
    { name: "Chipotle", detail: "Peanut-free · ~$12 · 0.3 mi", votes: 0 },
  ],
};
const votes = [[1, 0, 0], [2, 1, 0], [3, 1, 0]];
const winner = {
  name: "Velvet Taco",
  time: "7:30 PM",
  picks: [
    { person: "Ashar", dish: "Chicken tikka taco ×2", calories: 640 },
    { person: "Ashwani", dish: "Crispy tofu tacos (veg)", calories: 580 },
    { person: "Princy", dish: "Grilled steak bowl, 38g protein", calories: 610 },
    { person: "Sam", dish: "Fish taco + elote", calories: 700 },
  ],
};

if (flag === "--render-only") {
  plan.options.forEach((o, i) => (o.votes = votes[1]![i]!));
  writeFileSync("plan-voting.jpg", await planJpeg(plan));
  writeFileSync("plan-final.jpg", await planJpeg({ ...plan, winner }));
  console.log("wrote plan-voting.jpg, plan-final.jpg");
  process.exit(0);
}
if (!to) throw new Error("usage: plan-demo.ts <+phone>");

const app = await Spectrum({ providers: [imessage.config()] });
const im = imessage(app);
const space = await im.space.create(await im.user(to));
const pause = () => new Promise((r) => setTimeout(r, 6_000));

console.log("card:", await sendPlanCard(space, plan));
for (const round of votes) {
  await pause();
  plan.options.forEach((o, i) => (o.votes = round[i]!));
  console.log("card:", await sendPlanCard(space, plan));
}
await pause();
console.log("card:", await sendPlanCard(space, { ...plan, winner }));

await app.stop();
