// The "it's on" card sent to everyone once a meal plan is settled: where, when, and who is going.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

export interface MeetupCard {
  meal: string;
  place: string;
  /** "7:00 PM" */
  time: string;
  /** "Saturday, Oct 10" */
  date: string;
  /** Everyone who said yes, the organizer first. */
  people: { name: string; walkMin?: number }[];
  /** One line under the list, e.g. "closest spot to all of you · farthest walk 6 min". */
  note?: string;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const cap = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : s);
const COLORS = ["#F97316", "#38BDF8", "#A78BFA", "#34D399", "#FB7185", "#FBBF24"];

/**
 * Lambda has no system fonts, so SVG text renders as empty boxes. Inter ships with the code (Lambda: ./fonts next to
 * the bundle; local: assets/fonts) and fontconfig is pointed at it before the first render.
 */
let fontsReady = false;
export function useBundledFonts(): string | undefined {
  if (fontsReady) return process.env.FONTCONFIG_FILE;
  const dir = [new URL("./fonts/", import.meta.url), new URL("../assets/fonts/", import.meta.url)].map((u) => fileURLToPath(u)).find((d) => existsSync(`${d}Inter-Regular.ttf`));
  if (!dir) return undefined;
  const work = `${tmpdir()}/dining-fontconfig`;
  mkdirSync(work, { recursive: true });
  const conf = `${work}/fonts.conf`;
  writeFileSync(conf, `<?xml version="1.0"?>\n<!DOCTYPE fontconfig SYSTEM "urn:fontconfig:fonts.dtd">\n<fontconfig>\n  <dir>${dir}</dir>\n  <cachedir>${work}/cache</cachedir>\n</fontconfig>\n`);
  process.env.FONTCONFIG_FILE = conf;
  process.env.FONTCONFIG_PATH = work;
  fontsReady = true;
  return conf;
}

/** Break a place name over at most two lines without cutting words. */
export function wrapName(name: string, perLine: number): string[] {
  if (name.length <= perLine) return [name];
  const words = name.split(" ");
  let first = "";
  for (const w of words) {
    if (`${first} ${w}`.trim().length > perLine && first) break;
    first = `${first} ${w}`.trim();
  }
  const rest = name.slice(first.length).trim();
  return rest ? [first, rest.length > perLine ? `${rest.slice(0, perLine - 1).trim()}…` : rest] : [first];
}

export async function meetupJpeg(c: MeetupCard): Promise<Buffer> {
  useBundledFonts();
  const W = 1200;
  const font = `font-family="Inter, Helvetica, Arial, sans-serif"`;
  const placeLines = wrapName(c.place, 22);
  const placeSize = placeLines.length > 1 ? 84 : c.place.length > 16 ? 100 : 118;
  const placeTop = 210;
  const placeBottom = placeTop + (placeLines.length - 1) * (placeSize + 8);
  const timeY = placeBottom + 120;
  const dateY = timeY + 62;
  const ruleY = dateY + 52;
  const listLabelY = ruleY + 74;
  const listTop = listLabelY + 40;
  const rowH = 112;
  const H = listTop + c.people.length * rowH + (c.note ? 130 : 70);

  const check = (cx: number, cy: number) =>
    `<circle cx="${cx}" cy="${cy}" r="26" fill="#16A34A"/><path d="M ${cx - 12} ${cy} L ${cx - 3} ${cy + 10} L ${cx + 13} ${cy - 10}" stroke="#FFFFFF" stroke-width="7" stroke-linecap="round" stroke-linejoin="round" fill="none"/>`;
  const rows = c.people
    .map((p, i) => {
      const y = listTop + i * rowH;
      const color = COLORS[i % COLORS.length]!;
      return `<rect x="70" y="${y}" width="1060" height="96" rx="24" fill="#FFFFFF" fill-opacity="0.06"/>
        <circle cx="132" cy="${y + 48}" r="34" fill="${color}"/>
        <text x="132" y="${y + 61}" fill="#0B0B0F" font-size="38" font-weight="800" text-anchor="middle">${esc(p.name.slice(0, 1).toUpperCase())}</text>
        <text x="196" y="${y + 61}" fill="#FFFFFF" font-size="46" font-weight="800">${esc(cap(p.name))}</text>
        ${p.walkMin ? `<text x="1010" y="${y + 59}" fill="#9CA3AF" font-size="30" font-weight="600" text-anchor="end">${p.walkMin} min walk</text>` : ""}
        ${check(1070, y + 48)}`;
    })
    .join("");

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
    <defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#241238"/><stop offset="1" stop-color="#0B0B0F"/></linearGradient></defs>
    <rect width="${W}" height="${H}" fill="url(#bg)"/>
    <rect x="0" y="0" width="${W}" height="14" fill="#F97316"/>
    <g ${font}>
      <text x="80" y="104" fill="#F97316" font-size="30" font-weight="800" letter-spacing="5">${esc(c.meal.toUpperCase())} · IT'S ON</text>
      ${placeLines.map((l, i) => `<text x="80" y="${placeTop + i * (placeSize + 8)}" fill="#FFFFFF" font-size="${placeSize}" font-weight="800">${esc(l)}</text>`).join("\n      ")}
      <rect x="80" y="${timeY - 66}" width="${Math.max(260, c.time.length * 44 + 70)}" height="92" rx="46" fill="#FBBF24"/>
      <text x="${80 + Math.max(260, c.time.length * 44 + 70) / 2}" y="${timeY}" fill="#1B1026" font-size="60" font-weight="800" text-anchor="middle">${esc(c.time)}</text>
      <text x="80" y="${dateY}" fill="#D1D5DB" font-size="38" font-weight="600">${esc(c.date)}</text>
      <line x1="80" y1="${ruleY}" x2="1120" y2="${ruleY}" stroke="#2A2A35" stroke-width="2"/>
      <text x="80" y="${listLabelY}" fill="#9CA3AF" font-size="26" font-weight="800" letter-spacing="4">GOING · ${c.people.length}</text>
      ${rows}
      ${c.note ? `<text x="80" y="${H - 52}" fill="#9CA3AF" font-size="28" font-weight="500">${esc(c.note)}</text>` : ""}
    </g></svg>`;
  return sharp(Buffer.from(svg)).jpeg({ quality: 92 }).toBuffer();
}

/**
 * The page behind the card: link-preview tags (title, description, picture) so iMessage can show it, and the same
 * card in HTML for when it's opened. Everything from the plan is escaped; nothing else is on it.
 */
export function cardPageHtml(c: MeetupCard, imageUrl: string, pageUrl: string): string {
  const who = c.people.map((p) => cap(p.name)).join(", ");
  const title = `${c.place} · ${c.time}`;
  const desc = `${cap(c.meal)}, ${c.date}. Going: ${who}`;
  const rows = c.people
    .map((p, i) => `<li><span class="dot" style="background:${COLORS[i % COLORS.length]}">${esc(p.name.slice(0, 1).toUpperCase())}</span><span class="nm">${esc(cap(p.name))}</span>${p.walkMin ? `<span class="walk">${p.walkMin} min walk</span>` : ""}<span class="ok">&#10003;</span></li>`)
    .join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<meta property="og:type" content="website"><meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(desc)}">
<meta property="og:image" content="${esc(imageUrl)}"><meta property="og:url" content="${esc(pageUrl)}"><meta name="twitter:card" content="summary_large_image">
<style>body{margin:0;background:#0b0b0f;color:#fff;font-family:-apple-system,BlinkMacSystemFont,"Inter",Helvetica,Arial,sans-serif}
main{max-width:560px;margin:0 auto;padding:28px 22px 40px;background:linear-gradient(135deg,#241238,#0b0b0f);min-height:100vh;border-top:6px solid #f97316}
.k{color:#f97316;font-weight:800;letter-spacing:.18em;font-size:13px;text-transform:uppercase}h1{font-size:40px;line-height:1.1;margin:10px 0 18px;font-weight:800}
.time{display:inline-block;background:#fbbf24;color:#1b1026;font-weight:800;font-size:26px;border-radius:999px;padding:8px 22px}.date{color:#d1d5db;font-size:17px;margin:10px 0 22px;font-weight:600}
h2{color:#9ca3af;font-size:12px;letter-spacing:.2em;font-weight:800;margin:0 0 10px}ul{list-style:none;padding:0;margin:0}
li{display:flex;align-items:center;gap:12px;background:rgba(255,255,255,.07);border-radius:16px;padding:12px 14px;margin-bottom:10px}
.dot{width:36px;height:36px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;color:#0b0b0f;font-weight:800}.nm{font-weight:800;font-size:20px;flex:1}
.walk{color:#9ca3af;font-size:14px;font-weight:600}.ok{background:#16a34a;color:#fff;width:28px;height:28px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;font-weight:800}
.note{color:#9ca3af;font-size:14px;margin-top:14px}</style></head><body><main>
<div class="k">${esc(c.meal)} &middot; it's on</div><h1>${esc(c.place)}</h1><div class="time">${esc(c.time)}</div><div class="date">${esc(c.date)}</div>
<h2>GOING &middot; ${c.people.length}</h2><ul>${rows}</ul>${c.note ? `<p class="note">${esc(c.note)}</p>` : ""}
</main></body></html>`;
}
