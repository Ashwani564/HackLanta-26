// "Your day" iMessage App card: pizza art (day-art.ts) + caption text,
// sent once per person per chat and then edited in place.
import { app, edit } from "spectrum-ts";
import { TIME_ZONE, type Day, budgetLeft as monthLeft, totals } from "./day.js";
import { dayJpeg } from "./day-art.js";

const PUBLIC_URL = process.env.PUBLIC_URL ?? "https://example.com";

// One card per (chat, person); kept so edit() can update the same bubble.
const cards = new Map<string, unknown>();

export const dayUrl = (day: Day) => `${PUBLIC_URL}/day/${day.key}`;

export async function sendDayCard(space: any, day: Day): Promise<"sent" | "updated"> {
  const content = app(`${dayUrl(day)}?v=${Date.now()}`, { layout: await layout(day) });
  const id = `${space.id}:${day.key}`;
  const existing = cards.get(id);
  if (existing) {
    try {
      await space.send(edit(content, existing as any));
      return "updated";
    } catch (err) {
      console.warn("  card edit failed, sending a new card:", err);
    }
  }
  cards.set(id, await space.send(content));
  return "sent";
}

async function layout(day: Day) {
  const t = totals(day);
  const g = day.goals;
  const calLeft = g.calories - t.calories;
  const budgetLeft = monthLeft(day);
  return {
    caption: `${fmt(t.calories)} / ${fmt(g.calories)} cal`,
    subcaption: `${Math.round(t.protein)}g protein · $${budgetLeft.toFixed(0)} left this month`,
    trailingCaption: calLeft >= 0 ? `${fmt(calLeft)} left` : `${fmt(-calLeft)} over`,
    trailingSubcaption: `${day.meals.length} meal${day.meals.length === 1 ? "" : "s"}`,
    image: new Uint8Array(await dayJpeg(day)),
    imageTitle: "Your day",
    imageSubtitle: new Date().toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric", timeZone: TIME_ZONE }),
    summary: `${fmt(t.calories)}/${fmt(g.calories)} cal, ${Math.round(t.protein)}g protein, $${budgetLeft.toFixed(0)} left this month`,
  };
}

const fmt = (n: number) => Math.round(n).toLocaleString("en-US");
