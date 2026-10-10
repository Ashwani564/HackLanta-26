// "Tonight's plan" group card: vote bars while deciding, then the winner
// with each person's pick. Sent once, then edited in place.
import sharp from "sharp";
import { app, edit } from "spectrum-ts";

const PUBLIC_URL = process.env.PUBLIC_URL ?? "https://example.com";

export type PlanOption = { name: string; detail: string; votes: number };
export type Pick = { person: string; dish: string; calories: number };
export type Plan = {
  id: string;
  question: string;
  voters: number;
  options: PlanOption[];
  winner?: { name: string; time: string; picks: Pick[] };
};

const cards = new Map<string, unknown>();

export async function sendPlanCard(space: any, plan: Plan): Promise<"sent" | "updated"> {
  const content = app(`${PUBLIC_URL}/plan/${plan.id}?v=${Date.now()}`, { layout: await layout(plan) });
  const existing = cards.get(plan.id);
  if (existing) {
    try {
      await space.send(edit(content, existing as any));
      return "updated";
    } catch (err) {
      console.warn("  plan card edit failed, sending a new card:", err);
    }
  }
  cards.set(plan.id, await space.send(content));
  return "sent";
}

async function layout(plan: Plan) {
  const voted = plan.options.reduce((a, o) => a + o.votes, 0);
  if (plan.winner) {
    const w = plan.winner;
    return {
      caption: `${w.name} · ${w.time}`,
      subcaption: w.picks.map((p) => `${p.person}: ${p.dish}`).join(" · "),
      trailingCaption: "Locked in ✅",
      trailingSubcaption: `${voted}/${plan.voters} voted`,
      image: new Uint8Array(await planJpeg(plan)),
      imageTitle: "Tonight's plan",
      imageSubtitle: w.name,
      summary: `Tonight: ${w.name} at ${w.time}`,
    };
  }
  const lead = [...plan.options].sort((a, b) => b.votes - a.votes)[0]!;
  return {
    caption: plan.question,
    subcaption: voted ? `${lead.name} is leading` : "Vote in the poll 👇",
    trailingCaption: `${voted}/${plan.voters} voted`,
    trailingSubcaption: `${plan.options.length} spots fit everyone`,
    image: new Uint8Array(await planJpeg(plan)),
    imageTitle: "Tonight's plan",
    imageSubtitle: "Voting open",
    summary: `${plan.question} ${voted}/${plan.voters} voted`,
  };
}

export async function planJpeg(plan: Plan): Promise<Buffer> {
  const W = 1200, H = 630;
  const font = `font-family="Helvetica Neue, Arial, sans-serif"`;
  let body: string;

  if (plan.winner) {
    const w = plan.winner;
    const rows = w.picks.map((p, i) => {
      const y = 300 + i * 78;
      return `<text x="80" y="${y}" fill="#9CA3AF" font-size="30" font-weight="600">${esc(p.person)}</text>
        <text x="300" y="${y}" fill="#FFF" font-size="34" font-weight="700">${esc(p.dish)}</text>
        <text x="1120" y="${y}" fill="#FBBF24" font-size="30" font-weight="700" text-anchor="end">~${p.calories} cal</text>`;
    }).join("");
    body = `
      <text x="80" y="110" fill="#FBBF24" font-size="30" font-weight="700" letter-spacing="4">TONIGHT ✓</text>
      <text x="80" y="190" fill="#FFF" font-size="76" font-weight="800">${esc(w.name)}</text>
      <text x="1120" y="190" fill="#FFF" font-size="48" font-weight="700" text-anchor="end">${esc(w.time)}</text>
      <line x1="80" y1="232" x2="1120" y2="232" stroke="#333" stroke-width="2"/>
      ${rows}`;
  } else {
    const max = Math.max(plan.voters, 1);
    const rows = plan.options.map((o, i) => {
      const y = 170 + i * 120;
      const bar = (o.votes / max) * 1040;
      return `<rect x="80" y="${y}" width="1040" height="92" rx="20" fill="#1F2937"/>
        ${o.votes ? `<rect x="80" y="${y}" width="${Math.max(bar, 40)}" height="92" rx="20" fill="#F97316"/>` : ""}
        <text x="112" y="${y + 44}" fill="#FFF" font-size="38" font-weight="700">${esc(o.name)}</text>
        <text x="112" y="${y + 76}" fill="#E5E7EB" font-size="24">${esc(o.detail)}</text>
        <text x="1090" y="${y + 60}" fill="#FFF" font-size="44" font-weight="800" text-anchor="end">${o.votes}</text>`;
    }).join("");
    const voted = plan.options.reduce((a, o) => a + o.votes, 0);
    body = `
      <text x="80" y="100" fill="#F97316" font-size="30" font-weight="700" letter-spacing="4">WHERE ARE WE EATING?</text>
      <text x="1120" y="100" fill="#9CA3AF" font-size="30" font-weight="600" text-anchor="end">${voted}/${plan.voters} voted</text>
      ${rows}`;
  }

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
    <rect width="${W}" height="${H}" fill="#0B0B0F"/><g ${font}>${body}</g></svg>`;
  return sharp(Buffer.from(svg)).jpeg({ quality: 88 }).toBuffer();
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
