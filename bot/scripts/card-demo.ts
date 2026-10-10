// Usage: tsx --env-file=.env scripts/card-demo.ts +15551234567
// Sends a "Your day" card with sample meals, then updates it in place.
import { Spectrum } from "spectrum-ts";
import { imessage } from "spectrum-ts/providers/imessage";
import { sendDayCard } from "../src/card.js";
import { logMeal } from "../src/day.js";

const to = process.argv[2];
if (!to) throw new Error("usage: card-demo.ts <+phone>");

const app = await Spectrum({ providers: [imessage.config()] });
const im = imessage(app);
const space = await im.space.create(await im.user(to));

await logMeal(to, { name: "Greek yogurt bowl", calories: 380, protein: 28, price: 6 });
console.log("card:", await sendDayCard(space, await logMeal(to, { name: "Iced latte", calories: 190, protein: 10, price: 5.5 })));

await new Promise((r) => setTimeout(r, 10_000));
console.log("card:", await sendDayCard(space, await logMeal(to, { name: "Chicken over rice", calories: 750, protein: 45, price: 11 })));

await app.stop();
