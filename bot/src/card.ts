// "Your day" iMessage App card: activity-style rings image + caption text,
// sent once per person per chat and then edited in place.
import sharp from "sharp";
import { app, edit } from "spectrum-ts";
import { type Day, totals } from "./day.js";

const PUBLIC_URL = process.env.PUBLIC_URL ?? "https://example.com";
const RINGS = [
  { label: "CAL", color: "#FF375F", track: "#3A0D17" },
  { label: "PROTEIN", color: "#A6FF00", track: "#2A3A06" },
  { label: "BUDGET", color: "#22D3EE", track: "#0B3138" },
];

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
  const budgetLeft = g.budget - t.spent;
  return {
    caption: `${fmt(t.calories)} / ${fmt(g.calories)} cal`,
    subcaption: `${Math.round(t.protein)}g protein · $${budgetLeft.toFixed(0)} left`,
    trailingCaption: calLeft >= 0 ? `${fmt(calLeft)} left` : `${fmt(-calLeft)} over`,
    trailingSubcaption: `${day.meals.length} meal${day.meals.length === 1 ? "" : "s"}`,
    image: new Uint8Array(await ringsJpeg(day)),
    imageTitle: "Your day",
    imageSubtitle: new Date().toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" }),
    summary: `${fmt(t.calories)}/${fmt(g.calories)} cal, ${Math.round(t.protein)}g protein, $${budgetLeft.toFixed(0)} left`,
  };
}

/** Apple Watch-style concentric rings for calories, protein and budget. */
export async function ringsJpeg(day: Day): Promise<Buffer> {
  const t = totals(day);
  const g = day.goals;
  const values = [t.calories / g.calories, t.protein / g.protein, t.spent / g.budget];
  const lines = [
    `${fmt(t.calories)} / ${fmt(g.calories)}`,
    `${Math.round(t.protein)} / ${g.protein}g`,
    `$${t.spent.toFixed(0)} / $${g.budget}`,
  ];

  const cx = 330, cy = 315, width = 64, gap = 8;
  const rings = RINGS.map((ring, i) => {
    const r = 230 - i * (width + gap);
    const c = 2 * Math.PI * r;
    const p = Math.min(values[i]!, 1);
    return `
      <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${ring.track}" stroke-width="${width}"/>
      <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${ring.color}" stroke-width="${width}"
        stroke-linecap="round" stroke-dasharray="${p * c} ${c}" transform="rotate(-90 ${cx} ${cy})"
        ${p === 0 ? 'stroke-opacity="0"' : ""}/>`;
  }).join("");

  const legend = RINGS.map((ring, i) => `
      <text x="660" y="${200 + i * 120}" fill="${ring.color}" font-size="30" font-weight="700" letter-spacing="3">${ring.label}</text>
      <text x="660" y="${250 + i * 120}" fill="#FFFFFF" font-size="46" font-weight="700">${lines[i]}</text>`).join("");

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630">
    <rect width="1200" height="630" fill="#000"/>
    ${rings}
    <g font-family="Helvetica Neue, Arial, sans-serif">${legend}</g>
  </svg>`;
  return sharp(Buffer.from(svg)).jpeg({ quality: 88 }).toBuffer();
}

const fmt = (n: number) => Math.round(n).toLocaleString("en-US");
