// "Your day" card art: the day is a pizza. Slices disappear as calories are
// eaten (what's left = calories left); eggs fill with yolk for protein and
// coins show the budget left. 1200x630 JPEG for the iMessage App card.
import sharp from "sharp";
import { TIME_ZONE, type Day, totals } from "./day.js";

const INK = "#2B1B17";
const BROWN = "#7A4E2D";
const RED = "#C0392B";
const DISPLAY = "Phosphate, Futura, Arial Black, sans-serif";
const NUMBER = "Futura, Avenir Next, Helvetica Neue, Arial, sans-serif";
const TYPE = "American Typewriter, Courier New, monospace";

// Deterministic "random" toppings so the pizza looks the same on every redraw.
const PEPPERONI: [number, number][] = [
  [0.3, 20], [0.62, 55], [0.45, 110], [0.75, 150], [0.28, 190],
  [0.6, 230], [0.8, 275], [0.42, 300], [0.72, 335], [0.15, 260], [0.55, 10],
];
const BASIL: [number, number, number][] = [[0.5, 80, 30], [0.7, 205, -40], [0.35, 320, 70], [0.65, 290, 10]];
const OLIVES: [number, number][] = [[0.82, 35], [0.38, 160], [0.85, 245], [0.52, 355]];
const CRUMBS: [number, number, number][] = [
  [0.7, 0.1, 6], [0.45, 0.25, 4], [0.85, 0.4, 5], [0.3, 0.55, 3], [0.6, 0.7, 6], [0.8, 0.85, 4], [0.5, 0.95, 5],
];

export async function dayJpeg(day: Day): Promise<Buffer> {
  const t = totals(day);
  const g = day.goals;
  const left = 1 - t.calories / g.calories; // fraction of pizza left
  const over = t.calories - g.calories;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630">
    ${defs()}
    <rect width="1200" height="630" fill="url(#gingham)"/>
    ${pizza(300, 315, Math.max(0, Math.min(1, left)), over)}
    ${menuCard(day, t, g, over)}
  </svg>`;
  return sharp(Buffer.from(svg)).jpeg({ quality: 90 }).toBuffer();
}

function defs() {
  return `<defs>
    <pattern id="gingham" width="64" height="64" patternUnits="userSpaceOnUse">
      <rect width="64" height="64" fill="#FFF8F0"/>
      <rect width="32" height="64" fill="#D64541" fill-opacity="0.32"/>
      <rect width="64" height="32" fill="#D64541" fill-opacity="0.32"/>
    </pattern>
    <radialGradient id="cheese" cx="45%" cy="40%" r="65%">
      <stop offset="0" stop-color="#FFE08A"/><stop offset="1" stop-color="#F6B93B"/>
    </radialGradient>
    <radialGradient id="crust" cx="50%" cy="50%" r="50%">
      <stop offset="0.86" stop-color="#E8A04A"/><stop offset="1" stop-color="#B86E25"/>
    </radialGradient>
    <radialGradient id="pep" cx="40%" cy="35%" r="70%">
      <stop offset="0" stop-color="#E5533D"/><stop offset="1" stop-color="#A61E22"/>
    </radialGradient>
    <filter id="shadow" x="-10%" y="-10%" width="120%" height="130%">
      <feDropShadow dx="0" dy="10" stdDeviation="12" flood-color="#000" flood-opacity="0.28"/>
    </filter>
  </defs>`;
}

/** Wedge from 12 o'clock, clockwise, covering `f` of the circle. */
function wedge(cx: number, cy: number, r: number, f: number) {
  if (f >= 0.999) return `M ${cx - r} ${cy} a ${r} ${r} 0 1 0 ${2 * r} 0 a ${r} ${r} 0 1 0 ${-2 * r} 0 Z`;
  const a = -Math.PI / 2 + f * 2 * Math.PI;
  return `M ${cx} ${cy} L ${cx} ${cy - r} A ${r} ${r} 0 ${f > 0.5 ? 1 : 0} 1 ${cx + r * Math.cos(a)} ${cy + r * Math.sin(a)} Z`;
}

const polar = (cx: number, cy: number, r: number, deg: number) => {
  const a = ((deg - 90) * Math.PI) / 180;
  return [cx + r * Math.cos(a), cy + r * Math.sin(a)] as const;
};

function pizza(cx: number, cy: number, f: number, over: number) {
  const R = 238;
  const board = `
    <circle cx="${cx}" cy="${cy}" r="${R + 34}" fill="#C98A52" filter="url(#shadow)"/>
    <circle cx="${cx}" cy="${cy}" r="${R + 34}" fill="none" stroke="#A86B38" stroke-width="6"/>
    ${[60, 120, 180, 230].map((r) => `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="#B87A45" stroke-width="3" stroke-opacity="0.55"/>`).join("")}`;

  // Crumbs where slices have been eaten.
  const crumbs = CRUMBS.filter(([, at]) => at > f)
    .map(([rr, at, s]) => {
      const [x, y] = polar(cx, cy, rr * R, at * 360);
      return `<circle cx="${x}" cy="${y}" r="${s}" fill="#D99A4E"/>`;
    })
    .join("");

  const toppings = `
    ${PEPPERONI.map(([rr, deg]) => {
      const [x, y] = polar(cx, cy, rr * (R - 45), deg);
      return `<circle cx="${x}" cy="${y}" r="27" fill="url(#pep)"/>
        <circle cx="${x - 8}" cy="${y - 6}" r="4" fill="#7E1416" fill-opacity="0.5"/><circle cx="${x + 9}" cy="${y + 7}" r="3" fill="#7E1416" fill-opacity="0.5"/>`;
    }).join("")}
    ${OLIVES.map(([rr, deg]) => {
      const [x, y] = polar(cx, cy, rr * (R - 45), deg);
      return `<circle cx="${x}" cy="${y}" r="11" fill="none" stroke="#2E2A26" stroke-width="7"/>`;
    }).join("")}
    ${BASIL.map(([rr, deg, rot]) => {
      const [x, y] = polar(cx, cy, rr * (R - 45), deg);
      return `<ellipse cx="${x}" cy="${y}" rx="22" ry="11" fill="#3E8E41" transform="rotate(${rot} ${x} ${y})"/>
        <line x1="${x - 18}" y1="${y}" x2="${x + 18}" y2="${y}" stroke="#2D6A30" stroke-width="2" transform="rotate(${rot} ${x} ${y})"/>`;
    }).join("")}`;

  const cuts = Array.from({ length: 8 }, (_, i) => {
    const [x, y] = polar(cx, cy, R, i * 45);
    return `<line x1="${cx}" y1="${cy}" x2="${x}" y2="${y}" stroke="#B86E25" stroke-width="4" stroke-opacity="0.7"/>`;
  }).join("");

  const pie =
    f <= 0.001
      ? ""
      : `<clipPath id="left"><path d="${wedge(cx, cy, R + 1, f)}"/></clipPath>
    <g clip-path="url(#left)">
      <circle cx="${cx}" cy="${cy}" r="${R}" fill="url(#crust)"/>
      <circle cx="${cx}" cy="${cy}" r="${R - 30}" fill="#C8401E"/>
      <circle cx="${cx}" cy="${cy}" r="${R - 38}" fill="url(#cheese)"/>
      ${toppings}
      ${cuts}
    </g>`;

  const stamp =
    over > 0
      ? `<g transform="rotate(-12 ${cx} ${cy})">
      <rect x="${cx - 175}" y="${cy - 58}" width="350" height="116" rx="18" fill="#FFF8F0" fill-opacity="0.85" stroke="${RED}" stroke-width="8"/>
      <text x="${cx}" y="${cy + 18}" text-anchor="middle" font-family="${DISPLAY}" font-size="58" fill="${RED}">+${fmt(over)} CAL</text>
    </g>`
      : f <= 0.001
        ? `<text x="${cx}" y="${cy + 20}" text-anchor="middle" font-family="${DISPLAY}" font-size="56" fill="#FFF8F0">ALL GONE!</text>`
        : "";

  return board + crumbs + pie + stamp;
}

function menuCard(day: Day, t: ReturnType<typeof totals>, g: Day["goals"], over: number) {
  const x = 610, y = 34, w = 556, h = 562;
  const calLeft = g.calories - t.calories;
  const budgetLeft = g.budget - t.spent;

  // Protein: 6 eggs; each fills with yolk as you get closer to the goal.
  const eggs = Array.from({ length: 6 }, (_, i) => {
    const fill = Math.max(0, Math.min(1, (t.protein / g.protein) * 6 - i));
    const ex = x + 70 + i * 84, ey = y + 362;
    return `<ellipse cx="${ex}" cy="${ey}" rx="30" ry="37" fill="#FFFDF7" stroke="${INK}" stroke-width="4"/>
      ${fill > 0 ? `<circle cx="${ex}" cy="${ey + 5}" r="${8 + 10 * fill}" fill="#FFB703" stroke="#E08E00" stroke-width="2"/>` : ""}`;
  }).join("");

  // Budget: 5 coins; spent coins become dashed outlines.
  const coins = Array.from({ length: 5 }, (_, i) => {
    const has = budgetLeft / g.budget > i / 5 + 0.001;
    const ox = x + 70 + i * 84, oy = y + 488;
    return has
      ? `<circle cx="${ox}" cy="${oy}" r="31" fill="#F4B400" stroke="#B07D00" stroke-width="4"/>
         <circle cx="${ox}" cy="${oy}" r="22" fill="none" stroke="#B07D00" stroke-width="2"/>
         <text x="${ox}" y="${oy + 11}" text-anchor="middle" font-family="${NUMBER}" font-weight="700" font-size="30" fill="#8A6100">$</text>`
      : `<circle cx="${ox}" cy="${oy}" r="31" fill="none" stroke="#B9A48C" stroke-width="4" stroke-dasharray="8 7"/>`;
  }).join("");

  const big = over > 0 ? `+${fmt(over)}` : fmt(calLeft);
  const bigLabel = over > 0 ? "calories over" : "calories left";
  // Futura digits are ~0.62em wide; shrink long numbers to fit the card.
  const bigSize = Math.min(122, Math.floor((w - 80) / (big.length * 0.62)));
  const date = new Date().toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: TIME_ZONE });

  return `
    <g filter="url(#shadow)"><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="30" fill="#FFF6E5"/></g>
    <path d="M ${x} ${y + 30} a 30 30 0 0 1 30 -30 h ${w - 60} a 30 30 0 0 1 30 30 v 44 h ${-w} Z" fill="${RED}"/>
    <text x="${x + w / 2}" y="${y + 57}" text-anchor="middle" font-family="${DISPLAY}" font-size="40" letter-spacing="3" fill="#FFF6E5">TODAY'S PIE</text>

    <text x="${x + 44}" y="${y + 130}" font-family="${TYPE}" font-size="30" fill="${BROWN}">${bigLabel}</text>
    <text x="${x + w - 44}" y="${y + 130}" text-anchor="end" font-family="${TYPE}" font-size="28" fill="${BROWN}">goal ${fmt(g.calories)}</text>
    <text x="${x + 40}" y="${y + 238}" font-family="${NUMBER}" font-weight="700" font-size="${bigSize}" fill="${over > 0 ? RED : INK}">${big}</text>
    <line x1="${x + 40}" y1="${y + 264}" x2="${x + w - 40}" y2="${y + 264}" stroke="${BROWN}" stroke-width="3" stroke-dasharray="10 9" stroke-opacity="0.6"/>

    <text x="${x + 44}" y="${y + 308}" font-family="${DISPLAY}" font-size="32" letter-spacing="2" fill="${INK}">PROTEIN</text>
    <text x="${x + w - 44}" y="${y + 308}" text-anchor="end" font-family="${NUMBER}" font-weight="700" font-size="32" fill="${INK}">${Math.round(t.protein)} / ${g.protein}g</text>
    ${eggs}

    <text x="${x + 44}" y="${y + 440}" font-family="${DISPLAY}" font-size="32" letter-spacing="2" fill="${INK}">BUDGET</text>
    <text x="${x + w - 44}" y="${y + 440}" text-anchor="end" font-family="${NUMBER}" font-weight="700" font-size="32" fill="${budgetLeft < 0 ? RED : INK}">${budgetLeft < 0 ? `$${(-budgetLeft).toFixed(0)} over` : `$${budgetLeft.toFixed(0)} left`}</text>
    ${coins}

    <text x="${x + w / 2}" y="${y + h - 16}" text-anchor="middle" font-family="${TYPE}" font-size="22" fill="${BROWN}">${day.meals.length} meal${day.meals.length === 1 ? "" : "s"} logged · ${date}</text>`;
}

const fmt = (n: number) => Math.round(n).toLocaleString("en-US");
