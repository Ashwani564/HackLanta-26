// The plan card as an iMessage app card, in the same look as the "Today's Pie" card (day-art.ts): gingham tablecloth,
// the pizza on its board (here a clock set to the meeting time), and a menu-style panel with the place and who's going.
// 1200x630 JPEG. Text is Inter (bundled; Lambda has no system fonts).
import sharp from "sharp";
import { defs, pizza } from "./day-art.js";
import { type MeetupCard, useBundledFonts, wrapName } from "./meetup-card.js";

const INK = "#2B1B17";
const BROWN = "#7A4E2D";
const RED = "#C0392B";
const COLORS = ["#F97316", "#38BDF8", "#A78BFA", "#34D399", "#FB7185", "#FBBF24"];
const FONT = `font-family="Inter, Helvetica, Arial, sans-serif"`;

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const cap = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : s);

/** "7:30 PM" -> hour and minute hand angles in degrees from 12 o'clock. */
export function clockAngles(time: string): { hour: number; minute: number } {
  const m = /(\d{1,2}):(\d{2})/.exec(time);
  const h = m ? Number(m[1]) % 12 : 0, min = m ? Number(m[2]) : 0;
  return { hour: (h + min / 60) * 30, minute: min * 6 };
}

const at = (cx: number, cy: number, r: number, deg: number) => {
  const a = ((deg - 90) * Math.PI) / 180;
  return [cx + r * Math.cos(a), cy + r * Math.sin(a)] as const;
};

/** A cream clock face over the pizza, hands on the meeting time. */
function clock(cx: number, cy: number, time: string) {
  const R = 150;
  const { hour, minute } = clockAngles(time);
  const ticks = Array.from({ length: 12 }, (_, i) => {
    const [x1, y1] = at(cx, cy, R - (i % 3 === 0 ? 26 : 16), i * 30);
    const [x2, y2] = at(cx, cy, R - 6, i * 30);
    return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${BROWN}" stroke-width="${i % 3 === 0 ? 7 : 4}" stroke-linecap="round"/>`;
  }).join("");
  const hand = (deg: number, len: number, w: number, color: string) => {
    const [x, y] = at(cx, cy, len, deg);
    return `<line x1="${cx}" y1="${cy}" x2="${x}" y2="${y}" stroke="${color}" stroke-width="${w}" stroke-linecap="round"/>`;
  };
  return `<g filter="url(#shadow)"><circle cx="${cx}" cy="${cy}" r="${R}" fill="#FFF6E5" stroke="${RED}" stroke-width="10"/></g>
    ${ticks}${hand(hour, R * 0.5, 14, INK)}${hand(minute, R * 0.74, 9, RED)}
    <circle cx="${cx}" cy="${cy}" r="14" fill="${INK}"/>`;
}

function panel(c: MeetupCard) {
  const x = 610, y = 34, w = 556, h = 562;
  const placeLines = wrapName(c.place, 17);
  const placeSize = 46, step = 52;
  const placeBase = y + 130;
  const pillTop = placeBase + (placeLines.length - 1) * step + 22;
  const pillW = Math.max(240, c.time.length * 34 + 60);
  const dateY = pillTop + 60 + 34;
  const ruleY = dateY + 18;
  const labelY = ruleY + 36;
  const rowH = 52;
  const shown = c.people.length > 3 ? c.people.slice(0, 2) : c.people;
  const rows = shown
    .map((p, i) => {
      const ry = labelY + 20 + i * rowH;
      return `<circle cx="${x + 62}" cy="${ry + 24}" r="21" fill="${COLORS[i % COLORS.length]}"/>
      <text x="${x + 62}" y="${ry + 33}" text-anchor="middle" font-size="24" font-weight="800" fill="${INK}">${esc(p.name.slice(0, 1).toUpperCase())}</text>
      <text x="${x + 100}" y="${ry + 33}" font-size="30" font-weight="800" fill="${INK}">${esc(cap(p.name))}</text>
      ${p.walkMin ? `<text x="${x + w - 44}" y="${ry + 32}" text-anchor="end" font-size="24" font-weight="600" fill="${BROWN}">${p.walkMin} min walk</text>` : ""}`;
    })
    .join("");
  const more = c.people.length > 3 ? `<text x="${x + 44}" y="${labelY + 20 + 2 * rowH + 31}" font-size="26" font-weight="700" fill="${BROWN}">+ ${c.people.length - 2} more going</text>` : "";
  return `<g ${FONT}>
    <g filter="url(#shadow)"><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="30" fill="#FFF6E5"/></g>
    <path d="M ${x} ${y + 30} a 30 30 0 0 1 30 -30 h ${w - 60} a 30 30 0 0 1 30 30 v 44 h ${-w} Z" fill="${RED}"/>
    <text x="${x + w / 2}" y="${y + 51}" text-anchor="middle" font-size="30" font-weight="800" letter-spacing="5" fill="#FFF6E5">${esc(c.meal.toUpperCase())} · IT'S ON</text>
    ${placeLines.map((l, i) => `<text x="${x + 44}" y="${placeBase + i * step}" font-size="${placeSize}" font-weight="800" fill="${INK}">${esc(l)}</text>`).join("\n    ")}
    <rect x="${x + 44}" y="${pillTop}" width="${pillW}" height="60" rx="30" fill="#FBBF24"/>
    <text x="${x + 44 + pillW / 2}" y="${pillTop + 43}" text-anchor="middle" font-size="40" font-weight="800" fill="${INK}">${esc(c.time)}</text>
    <text x="${x + 44}" y="${dateY}" font-size="26" font-weight="600" fill="${BROWN}">${esc(c.date)}</text>
    <line x1="${x + 40}" y1="${ruleY}" x2="${x + w - 40}" y2="${ruleY}" stroke="${BROWN}" stroke-width="3" stroke-dasharray="10 9" stroke-opacity="0.6"/>
    <text x="${x + 44}" y="${labelY}" font-size="24" font-weight="800" letter-spacing="4" fill="${BROWN}">GOING · ${c.people.length}</text>
    ${rows}${more}
  </g>`;
}

export async function meetupArtJpeg(c: MeetupCard): Promise<Buffer> {
  useBundledFonts();
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630">
    ${defs()}
    <rect width="1200" height="630" fill="url(#gingham)"/>
    ${pizza(300, 315, 1, 0)}
    ${clock(300, 315, c.time)}
    ${panel(c)}
  </svg>`;
  return sharp(Buffer.from(svg)).jpeg({ quality: 90 }).toBuffer();
}

/** The app card's layout: picture with the title over it, and a caption row under it (same shape as the pie card). */
export async function meetupLayout(c: MeetupCard) {
  const maxWalk = Math.max(0, ...c.people.map((p) => p.walkMin ?? 0));
  const names = c.people.map((p) => cap(p.name)).join(", ");
  return {
    caption: c.place,
    subcaption: `${c.time} · ${names}`,
    trailingCaption: `${c.people.length} going`,
    trailingSubcaption: maxWalk > 0 ? `${maxWalk} min walk` : cap(c.meal),
    image: new Uint8Array(await meetupArtJpeg(c)),
    imageTitle: `${cap(c.meal)}'s on`,
    imageSubtitle: c.date,
    summary: `${cap(c.meal)} at ${c.place}, ${c.time}. Going: ${names}`,
  };
}
