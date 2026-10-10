// Food photo -> Gemini Flash-Lite (labels, boxes, calories) -> SAM 2 masks from
// those boxes (local vision-server) -> the same photo with tinted masks and
// calorie labels drawn on top. Falls back to plain boxes if SAM 2 is down.
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { GoogleGenAI, Type } from "@google/genai";
import sharp from "sharp";

const run = promisify(execFile);
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const SAM_URL = process.env.SAM_URL ?? "http://127.0.0.1:8788";
const MAX_SIDE = 1280;
const COLORS = ["#FF375F", "#30D158", "#0A84FF", "#FFD60A", "#BF5AF2", "#FF9F0A", "#64D2FF", "#FF6482"];

const PROMPT = `Detect each distinct food or drink item in this photo (e.g. rice, chicken, salad, sauce, drink).
Skip plates, cutlery, hands, and table. Merge tiny garnishes into the item they sit on. Max 8 items.
For each: a short label (1-3 words), box_2d as [ymin, xmin, ymax, xmax] normalized to 0-1000,
estimated calories and grams of protein for the visible portion. If there is no food, return [].`;

const SCHEMA = {
  type: Type.ARRAY,
  items: {
    type: Type.OBJECT,
    properties: {
      label: { type: Type.STRING },
      box_2d: { type: Type.ARRAY, items: { type: Type.INTEGER } },
      calories: { type: Type.INTEGER },
      protein_g: { type: Type.INTEGER },
    },
    required: ["label", "box_2d", "calories", "protein_g"],
  },
};

export type FoodItem = {
  label: string;
  box_2d: [number, number, number, number];
  calories: number;
  protein_g: number;
};

export async function annotateFood(input: Buffer): Promise<{ image: Buffer; items: FoodItem[]; timings: Record<string, number> }> {
  const timings: Record<string, number> = {};
  let t = Date.now();
  // Normalize: any format (HEIC included) -> upright JPEG <= MAX_SIDE, so
  // Gemini's coordinates line up with the pixels we draw on.
  const base = await sharp(await toJpeg(input))
    .rotate()
    .resize(MAX_SIDE, MAX_SIDE, { fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 90 })
    .toBuffer();
  const { width: W, height: H } = await sharp(base).metadata();
  timings.prep = Date.now() - t;

  t = Date.now();
  const items = await detect(base);
  timings.gemini = Date.now() - t;
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

// Flash-Lite usually answers in ~1.5s but sometimes stalls for 15s+, so we hedge:
// fire another request if the first is slow, take whichever succeeds first.
const HEDGES: [model: string, startAfterMs: number][] = [
  ["gemini-3.1-flash-lite", 0],
  ["gemini-3.1-flash-lite", 2500],
  ["gemini-2.5-flash", 5000],
];
const DETECT_TIMEOUT_MS = 20000;

async function detect(jpeg: Buffer): Promise<FoodItem[]> {
  const contents = [{ role: "user", parts: [{ inlineData: { mimeType: "image/jpeg", data: jpeg.toString("base64") } }, { text: PROMPT }] }];
  const controllers: AbortController[] = [];
  const timers: NodeJS.Timeout[] = [];

  const attempt = (model: string) => {
    const ctrl = new AbortController();
    controllers.push(ctrl);
    return ai.models
      .generateContent({
        model,
        contents,
        config: {
          responseMimeType: "application/json",
          responseSchema: SCHEMA,
          maxOutputTokens: 1024,
          // Google recommends no thinking for detection.
          thinkingConfig: { thinkingBudget: 0 },
          abortSignal: ctrl.signal,
        },
      })
      .then((res) => {
        const parsed = JSON.parse(res.text ?? "[]");
        return (Array.isArray(parsed) ? parsed : []).filter(
          (it: any) => it?.label && Array.isArray(it.box_2d) && it.box_2d.length === 4,
        ) as FoodItem[];
      });
  };

  try {
    return await new Promise<FoodItem[]>((resolve, reject) => {
      let pending = HEDGES.length;
      let lastErr: unknown;
      const fail = (err: unknown) => {
        lastErr = err;
        if (--pending === 0) reject(lastErr);
      };
      for (const [model, delay] of HEDGES) {
        timers.push(
          setTimeout(() => {
            attempt(model).then(resolve, (err) => {
              if ((err as Error)?.name !== "AbortError") console.warn(`  ${model} failed: ${(err as any)?.status ?? (err as Error).message}`);
              fail(err);
            });
          }, delay),
        );
      }
      timers.push(setTimeout(() => reject(new Error("Gemini detection timed out")), DETECT_TIMEOUT_MS));
    });
  } finally {
    timers.forEach(clearTimeout);
    controllers.forEach((c) => c.abort());
  }
}

/** Ask the local SAM 2 server for one mask per box. Undefined if it's not running. */
async function samMasks(jpeg: Buffer, boxes: ReturnType<typeof toPixels>[], W: number, H: number) {
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
async function toJpeg(input: Buffer): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), "photo-"));
  try {
    await writeFile(join(dir, "in"), input);
    await run("sips", ["-s", "format", "jpeg", join(dir, "in"), "--out", join(dir, "out.jpg")]);
    return await readFile(join(dir, "out.jpg"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
