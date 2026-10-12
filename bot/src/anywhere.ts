// Food anywhere, not just around campus. Real places near a location come from OpenStreetMap (free, no key); with no
// menu data for them, the model suggests typical dishes with estimated numbers, and the reply always says to check
// with the restaurant. Around GSU the real menus and the hard allergy filters are used instead (dining.ts).
import { converseTool } from "../../src/llm/bedrock.js";
import { haversineKm } from "../../src/pipeline/filter.js";
import type { Constraints } from "../../src/types.js";
import type { Origin } from "./dining.js";

export const anywhereEnabled = () => process.env.ANYWHERE !== "0";

export interface OsmPlace {
  id: string;
  name: string;
  lat: number;
  lng: number;
  cuisine: string[];
  km: number;
}

const UA = { "user-agent": "snacxx-bot/1.0 (HackLanta '26 iMessage food agent)" };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type OsmElement = { type: string; id: number; lat?: number; lon?: number; center?: { lat: number; lon: number }; tags?: Record<string, string> };

async function overpass(o: Origin, radiusM: number): Promise<OsmElement[]> {
  const q = `[out:json][timeout:15];nwr["amenity"~"^(restaurant|fast_food|cafe|food_court)$"]["name"](around:${radiusM},${o.lat},${o.lng});out center 60;`;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(`https://overpass-api.de/api/interpreter?data=${encodeURIComponent(q)}`, { headers: UA, signal: AbortSignal.timeout(20000) });
      const text = await res.text();
      if (res.ok && text.trimStart().startsWith("{")) return (JSON.parse(text) as { elements?: OsmElement[] }).elements ?? [];
    } catch {
      /* busy or slow: try again */
    }
    await sleep(1500 * (attempt + 1));
  }
  return [];
}

/** Second source when Overpass is busy: Nominatim's search, limited to a box around the person. */
async function nominatim(o: Origin, radiusM: number): Promise<OsmElement[]> {
  const d = radiusM / 111_000;
  const box = [o.lng - d, o.lat + d, o.lng + d, o.lat - d].join(",");
  const out: OsmElement[] = [];
  for (const q of ["restaurant", "fast food"]) {
    try {
      const res = await fetch(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=25&bounded=1&viewbox=${box}&q=${encodeURIComponent(q)}`, { headers: UA, signal: AbortSignal.timeout(15000) });
      const rows = (await res.json()) as { osm_type: string; osm_id: number; lat: string; lon: string; name?: string; type?: string }[];
      for (const r of rows) if (r.name) out.push({ type: r.osm_type, id: r.osm_id, lat: Number(r.lat), lon: Number(r.lon), tags: { name: r.name, amenity: r.type ?? "restaurant" } });
    } catch {
      /* nothing from this one */
    }
    await sleep(1100); // Nominatim allows one request a second
  }
  return out;
}

/** Named places to eat near a point, nearest first, one per name. */
export async function osmNearby(o: Origin, radiusM = 2000, limit = 12): Promise<OsmPlace[]> {
  let els = await overpass(o, radiusM);
  if (els.length === 0) els = await nominatim(o, radiusM);
  const seen = new Set<string>();
  return els
    .map((e): OsmPlace | undefined => {
      const lat = e.lat ?? e.center?.lat;
      const lng = e.lon ?? e.center?.lon;
      const name = e.tags?.name?.trim();
      if (lat === undefined || lng === undefined || !name) return undefined;
      const cuisine = (e.tags?.cuisine ?? e.tags?.amenity ?? "").split(/[;,]/).map((c) => c.trim().replace(/_/g, " ")).filter(Boolean);
      return { id: `osm-${e.type}${e.id}`, name, lat, lng, cuisine, km: haversineKm(o, { lat, lng }) };
    })
    .filter((p): p is OsmPlace => !!p)
    .sort((a, b) => a.km - b.km)
    .filter((p) => {
      const k = p.name.toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .slice(0, limit);
}

export interface AiDish {
  name: string;
  calories: number | null;
  proteinG: number | null;
  carbsG: number | null;
  fatG: number | null;
  priceUsd: number | null;
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.round(v) : null);

/** Two typical dishes at a place we have no menu for, with estimated numbers. Never claims anything is safe. */
export async function aiDishes(place: { name: string; cuisine: string[] }, request: string, c: Constraints): Promise<AiDish[]> {
  const avoid = [...c.allergens, ...c.unmappedAllergyTerms].join(", ");
  const out = await converseTool<{ dishes?: { name?: string; calories?: number; protein_g?: number; carbs_g?: number; fat_g?: number; price_usd?: number }[] }>({
    system:
      "You suggest two real, typical dishes someone could order at a restaurant you only know by name and cuisine. Use dishes such a place very likely serves. Estimate calories, protein, carbs and fat for a normal portion, and a typical US price. If the person has allergies or a diet, pick dishes that usually don't contain those ingredients. Keep dish names short.",
    user: JSON.stringify({ restaurant: place.name, cuisine: place.cuisine.join(", ") || "unknown", wants: request || "a good main dish", avoid_ingredients: avoid || "none", diets: c.diets.join(", ") || "none", max_price_usd: c.budgetMaxUsd ?? null }),
    toolName: "suggest_dishes",
    toolDescription: "Two dishes to suggest at this restaurant, with estimated nutrition and price.",
    schema: {
      type: "object",
      properties: {
        dishes: {
          type: "array",
          items: {
            type: "object",
            properties: { name: { type: "string" }, calories: { type: "number" }, protein_g: { type: "number" }, carbs_g: { type: "number" }, fat_g: { type: "number" }, price_usd: { type: "number" } },
            required: ["name", "calories", "protein_g"],
          },
        },
      },
      required: ["dishes"],
    },
    maxTokens: 700,
  });
  return (out.dishes ?? [])
    .filter((d) => typeof d.name === "string" && d.name.trim())
    .slice(0, 2)
    .map((d) => ({ name: d.name!.trim().toLowerCase(), calories: num(d.calories), proteinG: num(d.protein_g), carbsG: num(d.carbs_g), fatG: num(d.fat_g), priceUsd: num(d.price_usd) }));
}
