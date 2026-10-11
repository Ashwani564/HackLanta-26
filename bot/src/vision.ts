// Food photo -> Claude on Bedrock (labels, rough boxes, calories). When SAM_URL points at a
// SAM 2 server (local or a cloud GPU), the boxes become masks and the photo comes back
// annotated; without it, callers reply with the calorie breakdown as text.
import { heifToJpeg } from "heif2jpeg";
import { BedrockRuntimeClient, ConverseCommand, type ToolInputSchema } from "@aws-sdk/client-bedrock-runtime";
import sharp from "sharp";

const bedrock = new BedrockRuntimeClient({ region: process.env.AWS_REGION ?? "us-east-2" });
export const SAM_URL = process.env.SAM_URL;
const MAX_SIDE = 1280;
const COLORS = ["#FF375F", "#30D158", "#0A84FF", "#FFD60A", "#BF5AF2", "#FF9F0A", "#64D2FF", "#FF6482"];

const PROMPT = `Detect each distinct food or drink item in this photo (e.g. rice, chicken, salad, sauce, drink).
Skip plates, cutlery, hands, and table. Merge tiny garnishes into the item they sit on. Max 8 items.
For each: a short label (1-3 words), box_2d as [ymin, xmin, ymax, xmax] normalized to 0-1000,
estimated calories and grams of protein for the visible portion. If there is no food, report an empty list.
The image has a cyan coordinate grid: lines every 100 units, labeled along the top (x) and left (y) edges. Read each item's edges off the grid.`;

const SCHEMA = {
  type: "object",
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          label: { type: "string", description: "Short name, 1-3 words" },
          box_2d: {
            type: "array",
            items: { type: "integer" },
            description: "[ymin, xmin, ymax, xmax] of the item's tight bounding box, each normalized 0-1000 relative to the image height/width",
          },
          calories: { type: "integer", description: "Estimated kcal for the visible portion" },
          protein_g: { type: "integer", description: "Estimated grams of protein" },
        },
        required: ["label", "box_2d", "calories", "protein_g"],
      },
    },
  },
  required: ["items"],
};

export type FoodItem = {
  label: string;
  box_2d: [number, number, number, number];
  calories: number;
  protein_g: number;
};

/** Labels + calories only (no drawing). Works anywhere, including Lambda. */
export async function analyzeFood(input: Buffer) {
  const timings: Record<string, number> = {};
  let t = Date.now();
  // Normalize: any format (HEIC included) -> upright JPEG <= MAX_SIDE, so
  // the model's coordinates line up with the pixels we draw on.
  const base = await sharp(await toJpeg(input))
    .rotate()
    .resize(MAX_SIDE, MAX_SIDE, { fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 90 })
    .toBuffer();
  timings.prep = Date.now() - t;
  t = Date.now();
  const items = await detect(base);
  timings.detect = Date.now() - t;
  return { base, items, timings };
}

const sum = (items: FoodItem[], f: (i: FoodItem) => number) => items.reduce((a, it) => a + (Number(f(it)) || 0), 0);

/** Plain template, used if the model is unavailable or gets a number wrong. */
export function foodSummary(items: FoodItem[]) {
  const cal = Math.round(sum(items, (i) => i.calories));
  const protein = Math.round(sum(items, (i) => i.protein_g));
  const big = [...items].sort((a, b) => b.calories - a.calories)[0]!;
  return `~${cal} cal, ${protein}g protein. the ${big.label.toLowerCase()} is the biggest chunk at ~${Math.round(big.calories)}`;
}

const REPLY_SYSTEM = `you're texting a friend your quick read on a photo of their meal. be to the point and casual, like a real person.
- one or two short lines. lowercase is fine.
- gen z tone: a touch of slang like "bro", "gang", "lowkey", "ngl", "W" (light meal) or "L" (heavy one), at most one or two per reply. the numbers stay exact.
- lead with the total calories and protein, using the exact numbers you're given (keep the "~").
- then at most one short remark: which item is most of the calories, or whether it's light or heavy.
- no lists, no bullet points, no markdown, no "looks delicious", no disclaimers, no questions. at most one emoji, usually none.`;

/** A casual one-or-two-line take on the meal. The numbers always come from the detected items. */
export async function casualFoodReply(items: FoodItem[]): Promise<string> {
  const cal = Math.round(sum(items, (i) => i.calories));
  const protein = Math.round(sum(items, (i) => i.protein_g));
  const modelId = process.env.BEDROCK_MODEL_ID;
  if (!modelId) return foodSummary(items);
  try {
    const res = await bedrock.send(
      new ConverseCommand({
        modelId,
        system: [{ text: REPLY_SYSTEM }],
        messages: [
          {
            role: "user",
            content: [{ text: JSON.stringify({ total_calories: cal, total_protein_g: protein, items: items.map((i) => ({ item: i.label, calories: Math.round(i.calories), protein_g: Math.round(i.protein_g) })) }) }],
          },
        ],
        inferenceConfig: { maxTokens: 120, temperature: 0.7 },
      }),
      { abortSignal: AbortSignal.timeout(8000) },
    );
    const text = (res.output?.message?.content ?? []).map((b) => b.text ?? "").join("").trim();
    // Must carry the real total, and must be short enough to read as a text.
    if (text && text.length <= 220 && text.includes(String(cal))) return text;
  } catch (err) {
    console.warn("  casual food reply failed, using template:", (err as Error).message);
  }
  return foodSummary(items);
}

/** Annotated photo (SAM 2 masks when SAM_URL is reachable, boxes otherwise). */
export async function annotateFood(input: Buffer): Promise<{ image: Buffer; items: FoodItem[]; timings: Record<string, number> }> {
  const { base, items, timings } = await analyzeFood(input);
  const { width: W, height: H } = await sharp(base).metadata();
  let t = Date.now();
  if (items.length === 0) return { image: base, items, timings };

  t = Date.now();
  const boxes = items.map((it) => toPixels(it.box_2d, W!, H!));
  const masks = await samMasks(base, boxes, W!, H!);
  timings.sam = Date.now() - t;

  t = Date.now();
  const layers: { input: Buffer; left: number; top: number; raw?: { width: number; height: number; channels: 4 } }[] = [];
  if (masks) layers.push({ input: maskLayer(masks, W!, H!), left: 0, top: 0, raw: { width: W!, height: H!, channels: 4 } });
  layers.push({ input: Buffer.from(overlaySvg(items, W!, H!, !masks)), left: 0, top: 0 });
  const image = await sharp(base).composite(layers).jpeg({ quality: 88 }).toBuffer();
  timings.draw = Date.now() - t;
  return { image, items, timings };
}

const DETECT_TIMEOUT_MS = 20000;

async function detect(jpeg: Buffer): Promise<FoodItem[]> {
  const modelId = process.env.BEDROCK_VISION_MODEL_ID ?? process.env.BEDROCK_MODEL_ID;
  if (!modelId) throw new Error("BEDROCK_MODEL_ID is not set");
  const res = await bedrock.send(
    new ConverseCommand({
      modelId,
      messages: [{ role: "user", content: [{ image: { format: "jpeg", source: { bytes: new Uint8Array(await withGrid(jpeg)) } } }, { text: PROMPT }] }],
      inferenceConfig: { maxTokens: 1500, temperature: 0 },
      toolConfig: {
        tools: [{ toolSpec: { name: "report_food_items", description: "Report every food item found in the photo.", inputSchema: { json: SCHEMA } as ToolInputSchema } }],
        toolChoice: { tool: { name: "report_food_items" } },
      },
    }),
    { abortSignal: AbortSignal.timeout(DETECT_TIMEOUT_MS) },
  );
  const call = res.output?.message?.content?.find((c) => c.toolUse)?.toolUse;
  const items = (call?.input as { items?: unknown })?.items;
  return (Array.isArray(items) ? items : []).filter(
    (it: any) => it?.label && Array.isArray(it.box_2d) && it.box_2d.length === 4 && it.box_2d.every((v: unknown) => typeof v === "number"),
  ) as FoodItem[];
}

/** Ask the local SAM 2 server for one mask per box. Undefined if it's not running. */
async function samMasks(jpeg: Buffer, boxes: ReturnType<typeof toPixels>[], W: number, H: number) {
  if (!SAM_URL) return undefined;
  const valid = boxes.map((b) => (b ? [b.x, b.y, b.x + b.w, b.y + b.h] : [0, 0, 1, 1]));
  try {
    const form = new FormData();
    form.append("image", new Blob([new Uint8Array(jpeg)], { type: "image/jpeg" }), "photo.jpg");
    form.append("boxes", JSON.stringify(valid));
    const res = await fetch(`${SAM_URL}/segment`, { method: "POST", body: form, signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`SAM ${res.status}`);
    const { masks } = (await res.json()) as { masks: string[] };
    return await Promise.all(
      masks.map(async (png, i) =>
        boxes[i] ? sharp(Buffer.from(png, "base64")).resize(W, H, { fit: "fill" }).greyscale().raw().toBuffer() : undefined,
      ),
    );
  } catch (err) {
    console.warn(`  SAM 2 unavailable, drawing boxes instead: ${(err as Error).message}`);
    return undefined;
  }
}

/** Masks -> one RGBA layer: translucent fill plus a solid edge in each item's color. */
function maskLayer(masks: (Buffer | undefined)[], W: number, H: number): Buffer {
  const out = Buffer.alloc(W * H * 4);
  const R = Math.max(2, Math.round(Math.max(W, H) / 400)); // edge thickness
  masks.forEach((m, i) => {
    if (!m) return;
    const [r, g, b] = hex(COLORS[i % COLORS.length]!);
    const inside = (x: number, y: number) => x >= 0 && y >= 0 && x < W && y < H && m[y * W + x]! > 127;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (!inside(x, y)) continue;
        const edge = !inside(x - R, y) || !inside(x + R, y) || !inside(x, y - R) || !inside(x, y + R);
        const o = (y * W + x) * 4;
        out[o] = r; out[o + 1] = g; out[o + 2] = b;
        out[o + 3] = edge ? 255 : 105;
      }
    }
  });
  return out;
}

const hex = (c: string) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16)) as [number, number, number];

function toPixels([ymin, xmin, ymax, xmax]: number[], W: number, H: number) {
  const x = Math.round((xmin! / 1000) * W), y = Math.round((ymin! / 1000) * H);
  const w = Math.round(((xmax! - xmin!) / 1000) * W), h = Math.round(((ymax! - ymin!) / 1000) * H);
  if (w < 4 || h < 4 || x < 0 || y < 0 || x + w > W || y + h > H) return undefined;
  return { x, y, w, h };
}

/** Calorie pill per item, a total banner, and (without SAM masks) a box per item. */
function overlaySvg(items: FoodItem[], W: number, H: number, drawBoxes: boolean) {
  const fs = Math.round(Math.max(W, H) / 38);
  const pad = Math.round(fs * 0.45);
  const pillH = fs + pad * 2;
  const charW = fs * 0.55;
  const stroke = Math.max(3, Math.round(fs / 7));
  const pillWidth = (text: string) => Math.round(text.length * charW + pad * 2);

  const cal = items.reduce((a, it) => a + (Number(it.calories) || 0), 0);
  const protein = items.reduce((a, it) => a + (Number(it.protein_g) || 0), 0);
  const total = `Total ~${Math.round(cal)} cal · ${Math.round(protein)}g protein (est.)`;
  const banner = { x: 8, y: 8, w: pillWidth(total), h: pillH };

  // Greedy label placement: try above / inside-top / below the item, then slide
  // down until the pill doesn't overlap anything already placed.
  const placed = [banner];
  const hits = (r: typeof banner) =>
    placed.some((q) => r.x < q.x + q.w + 4 && q.x < r.x + r.w + 4 && r.y < q.y + q.h + 4 && q.y < r.y + r.h + 4);
  const place = (box: { x: number; y: number; w: number; h: number }, w: number) => {
    const x = Math.min(Math.max(box.x, 4), W - w - 4);
    const clampY = (y: number) => Math.min(Math.max(y, 4), H - pillH - 4);
    for (const y0 of [box.y - pillH - 6, box.y + 6, box.y + box.h + 6]) {
      for (let y = clampY(y0); y <= H - pillH - 4; y += pillH / 2) {
        const r = { x, y, w, h: pillH };
        if (!hits(r)) return r;
      }
    }
    return { x, y: clampY(box.y), w, h: pillH };
  };

  const shapes: string[] = [];
  const pills: string[] = [];
  items.forEach((item, i) => {
    const color = COLORS[i % COLORS.length]!;
    const box = toPixels(item.box_2d, W, H);
    if (!box) return;
    if (drawBoxes) {
      shapes.push(`<rect x="${box.x}" y="${box.y}" width="${box.w}" height="${box.h}" rx="${fs / 2}"
        fill="${color}" fill-opacity="0.2" stroke="${color}" stroke-width="${stroke}"/>`);
    }
    const label = item.label.charAt(0).toUpperCase() + item.label.slice(1);
    const text = `${label} · ${Math.round(item.calories)} cal`;
    const r = place(box, pillWidth(text));
    placed.push(r);
    pills.push(`<rect x="${r.x}" y="${r.y}" width="${r.w}" height="${pillH}" rx="${pillH / 2}" fill="${color}"/>
      <text x="${r.x + pad}" y="${r.y + pad + fs * 0.82}" font-size="${fs}" font-weight="700" fill="#000">${esc(text)}</text>`);
  });

  // Shapes first, pills on top so labels are never covered.
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
    <g font-family="Helvetica Neue, Arial, sans-serif">
      ${shapes.join("")}
      ${pills.join("")}
      <rect x="${banner.x}" y="${banner.y}" width="${banner.w}" height="${pillH}" rx="${pillH / 2}" fill="#000" fill-opacity="0.75"/>
      <text x="${banner.x + pad}" y="${banner.y + pad + fs * 0.82}" font-size="${fs}" font-weight="700" fill="#FFF">${esc(total)}</text>
    </g></svg>`;
}

/** HEIC and friends -> JPEG via macOS sips (sharp's prebuilt libvips can't decode HEVC). */
/** HEIC/HEIF (iPhone photos) -> JPEG via Photon's heif2jpeg; everything else goes straight to sharp. */
async function toJpeg(input: Buffer): Promise<Buffer> {
  const brand = input.toString("ascii", 4, 12); // ISO-BMFF "ftypheic", "ftypmif1", ...
  if (brand.startsWith("ftyp") && /hei|hev|mif|msf|avif/.test(brand.slice(4))) return heifToJpeg(input, { quality: 90 });
  return input;
}

/** Cyan coordinate grid (every 100 of 0-1000) drawn on the copy sent to the model: in testing it
 *  raised Claude Haiku's box overlap with the real items from 0.04 to 0.48. */
async function withGrid(jpeg: Buffer): Promise<Buffer> {
  const { width: W, height: H } = await sharp(jpeg).metadata();
  const marks: string[] = [];
  for (let v = 0; v <= 1000; v += 100) {
    const x = (v / 1000) * W!, y = (v / 1000) * H!;
    marks.push(`<line x1="${x}" y1="0" x2="${x}" y2="${H}" stroke="#00E5FF" stroke-width="2" opacity="0.7"/>`,
      `<text x="${x + 3}" y="22" font-size="20" font-family="Arial, sans-serif" font-weight="700" fill="#00E5FF" stroke="#000" stroke-width="0.6">${v}</text>`,
      `<line x1="0" y1="${y}" x2="${W}" y2="${y}" stroke="#00E5FF" stroke-width="2" opacity="0.7"/>`,
      `<text x="3" y="${y - 4}" font-size="20" font-family="Arial, sans-serif" font-weight="700" fill="#00E5FF" stroke="#000" stroke-width="0.6">${v}</text>`);
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">${marks.join("")}</svg>`;
  return sharp(jpeg).composite([{ input: Buffer.from(svg) }]).jpeg({ quality: 88 }).toBuffer();
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
