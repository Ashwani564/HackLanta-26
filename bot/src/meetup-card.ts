// The "it's on" card sent to everyone once a meal plan is settled: where, when, who, and how far each person walks.
import sharp from "sharp";

export interface MeetupCard {
  meal: string;
  place: string;
  /** "7:00 PM" */
  time: string;
  /** "Saturday, Oct 10" */
  date: string;
  people: { name: string; walkMin?: number }[];
  /** One line under the list, e.g. "closest spot to all of you · farthest walk 6 min". */
  note?: string;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const cap = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : s);
const COLORS = ["#F97316", "#38BDF8", "#A78BFA", "#34D399", "#FB7185", "#FBBF24"];

export async function meetupJpeg(c: MeetupCard): Promise<Buffer> {
  const W = 1200;
  const rowH = 96;
  const listTop = 430;
  const H = listTop + c.people.length * rowH + (c.note ? 120 : 70);
  const font = `font-family="Helvetica Neue, Arial, sans-serif"`;
  const placeSize = c.place.length > 26 ? 58 : c.place.length > 18 ? 74 : 92;

  const rows = c.people
    .map((p, i) => {
      const y = listTop + i * rowH;
      const color = COLORS[i % COLORS.length]!;
      return `<circle cx="116" cy="${y + 34}" r="30" fill="${color}"/>
        <text x="116" y="${y + 46}" fill="#0B0B0F" font-size="32" font-weight="800" text-anchor="middle">${esc(p.name.slice(0, 1).toUpperCase())}</text>
        <text x="172" y="${y + 46}" fill="#FFFFFF" font-size="38" font-weight="700">${esc(cap(p.name))}</text>
        ${p.walkMin ? `<text x="1120" y="${y + 46}" fill="#9CA3AF" font-size="30" font-weight="600" text-anchor="end">${p.walkMin} min walk</text>` : ""}`;
    })
    .join("");

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
    <defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#1B1026"/><stop offset="1" stop-color="#0B0B0F"/></linearGradient></defs>
    <rect width="${W}" height="${H}" fill="url(#bg)"/>
    <rect x="0" y="0" width="14" height="${H}" fill="#F97316"/>
    <g ${font}>
      <text x="80" y="100" fill="#F97316" font-size="30" font-weight="800" letter-spacing="5">${esc(c.meal.toUpperCase())} · LOCKED IN</text>
      <text x="80" y="${200 + (92 - placeSize) / 2}" fill="#FFFFFF" font-size="${placeSize}" font-weight="800">${esc(c.place)}</text>
      <text x="80" y="290" fill="#FBBF24" font-size="64" font-weight="800">${esc(c.time)}</text>
      <text x="80" y="345" fill="#D1D5DB" font-size="36" font-weight="500">${esc(c.date)}</text>
      <line x1="80" y1="385" x2="1120" y2="385" stroke="#2A2A35" stroke-width="2"/>
      <text x="80" y="${listTop - 12}" fill="#9CA3AF" font-size="24" font-weight="700" letter-spacing="4">WHO'S COMING</text>
      ${rows}
      ${c.note ? `<text x="80" y="${H - 50}" fill="#9CA3AF" font-size="28" font-weight="500">${esc(c.note)}</text>` : ""}
    </g></svg>`;
  return sharp(Buffer.from(svg)).jpeg({ quality: 90 }).toBuffer();
}
