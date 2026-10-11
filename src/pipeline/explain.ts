import type { Candidate } from "../types.js";
import { converseTool } from "../llm/bedrock.js";

export interface Pick {
  dish: Candidate;
  reason: string;
  /** Casual mode only: the dish as a person would say it ("tofu tikka masala"), built from the menu name's own words. */
  name?: string;
}

interface RawPicks {
  picks?: { dish_id?: unknown; reason?: unknown; casual_name?: unknown }[];
}

const SCHEMA = {
  type: "object",
  properties: {
    picks: {
      type: "array",
      maxItems: 3,
      items: {
        type: "object",
        properties: {
          dish_id: { type: "string", description: "Must be one of the dish_id values you were given, copied exactly." },
          reason: { type: "string", description: "One short sentence, under 18 words, about taste or fit with the request." },
        },
        required: ["dish_id", "reason"],
      },
    },
  },
  required: ["picks"],
};

const CASUAL_SCHEMA = {
  type: "object",
  properties: {
    picks: {
      type: "array",
      maxItems: 3,
      items: {
        type: "object",
        properties: {
          dish_id: { type: "string", description: "Must be one of the dish_id values you were given, copied exactly." },
          casual_name: { type: "string", description: "The dish the way a person would say it out loud, cleaned up from the menu name. Reuse only words from the menu name; drop shouting caps and menu noise like 'served with rice'." },
          reason: { type: "string", description: "A short, casual fragment a friend would text, under 14 words, no ending period needed. Example: 'loaded with rice, beans and double chicken, 65g protein'." },
        },
        required: ["dish_id", "casual_name", "reason"],
      },
    },
  },
  required: ["picks"],
};

const CASUAL_SYSTEM = `You pick dishes from a candidate list for a friend who is deciding what to order, and say why in a few casual words.
Rules:
- Choose ONLY dish_id values from the list, copied exactly. Pick dishes that are different from each other.
- Every candidate already passed the person's dietary and allergy filters. Never say or imply anything is "safe", "allergen-free" or "free of" something.
- Never mention anyone's health, allergies, diet or goals.
- Use ONLY facts in the candidate's fields (dish, category, description, price, calories, protein). Never invent ingredients, spice, flavor or preparation. If the description is empty, say only what the name and numbers tell you.
- Write like a gen z friend texting: lowercase is fine, short, plain words, light slang ("lowkey", "ngl", "bro", "gang", "W" for a good deal or macro) at most once per line, no hype, no emoji, no "delicious" or "mouthwatering".
- Slang never replaces the facts: price, calories and protein stay exact and are stated plainly.`;

const SYSTEM = `You pick up to 3 dishes for a group chat from a candidate list and write one short line for each.
Rules:
- Choose ONLY dish_id values from the list, copied exactly. Prefer variety across restaurants.
- Every candidate already passed everyone's dietary and allergy filters. Never say or imply anything is "safe", "allergen-free" or "free of" something.
- Never mention a person's health, allergies, diet or goals. If it helps, you may say it "works for everyone".
- Use ONLY facts present in the candidate's fields (dish, restaurant, category, description, price, calories, protein). Never invent ingredients, spice levels, flavors or preparation. If the description is empty, say only what the dish name and category already tell you.
- Plain text, no emoji.`;

// A reason that claims safety is replaced with a neutral line. Safety claims come from code, never the model.
export const SAFETY_CLAIM = /\b(allergen[- ]?free|safe|free of|free from|guarantee|no (milk|dairy|egg|wheat|gluten|soy|nuts?|peanuts?|shellfish|fish|sesame))\b/i;

const fallbackReason = (d: Candidate) => `A solid pick at ${d.restaurantName}.`;

export function cleanReason(reason: unknown, dish: Candidate): string {
  const text = typeof reason === "string" ? reason.trim().replace(/\s+/g, " ") : "";
  if (!text || text.length > 160 || SAFETY_CLAIM.test(text)) return fallbackReason(dish);
  return text;
}

/**
 * Validate the model's picks against the candidate list: unknown IDs and duplicates are dropped.
 * If fewer than `want` valid picks remain, top-ranked candidates fill in with a code-written line.
 */
const tokens = (t: string) => t.toLowerCase().match(/[a-z0-9]+/g) ?? [];

/** A casual name is accepted only if every word comes from the menu name (no invented ingredients). */
export function cleanCasualName(name: unknown, dish: Candidate): string | undefined {
  if (typeof name !== "string") return undefined;
  const text = name.trim().replace(/\s+/g, " ");
  if (!text || text.length > 60) return undefined;
  const allowed = new Set(tokens(dish.dishName));
  const words = tokens(text);
  return words.length > 0 && words.every((w) => allowed.has(w)) ? text : undefined;
}

export function validatePicks(raw: RawPicks, ranked: readonly Candidate[], want = 3): Pick[] {
  const byId = new Map(ranked.map((c) => [c.dishId, c]));
  const picks: Pick[] = [];
  const used = new Set<string>();
  for (const p of raw.picks ?? []) {
    if (typeof p.dish_id !== "string") continue;
    const dish = byId.get(p.dish_id);
    if (!dish || used.has(dish.dishId)) continue;
    used.add(dish.dishId);
    const name = cleanCasualName(p.casual_name, dish);
    picks.push({ dish, reason: cleanReason(p.reason, dish), ...(name && { name }) });
    if (picks.length === want) return picks;
  }
  for (const dish of ranked) {
    if (picks.length >= want) break;
    if (used.has(dish.dishId)) continue;
    used.add(dish.dishId);
    picks.push({ dish, reason: fallbackReason(dish) });
  }
  return picks;
}

export async function pickDishes(
  request: string,
  ranked: readonly Candidate[],
  want = 3,
  opts: { casual?: boolean } = {},
): Promise<Pick[]> {
  const top = ranked.slice(0, 15);
  if (top.length === 0) return [];
  const list = top.map((d) => ({
    dish_id: d.dishId,
    dish: d.dishName,
    restaurant: d.restaurantName,
    category: d.category,
    description: d.description.slice(0, 140),
    price_usd: d.priceUsd,
    calories: d.calories,
    protein_g: d.proteinG,
  }));
  try {
    const raw = await converseTool<RawPicks>({
      system: opts.casual ? CASUAL_SYSTEM : SYSTEM,
      user: `Request: ${request}\n\n${opts.casual ? `Pick ${want}.\n\n` : ""}Candidates:\n${JSON.stringify(list)}`,
      toolName: "pick_dishes",
      toolDescription: opts.casual ? `Return up to ${want} chosen dishes with a short reason each.` : "Return up to 3 chosen dishes with a one-line reason each.",
      schema: opts.casual ? CASUAL_SCHEMA : SCHEMA,
    });
    return validatePicks(raw, top, want);
  } catch {
    // If the model is down or returns garbage, the ranked list still produces a valid reply.
    return validatePicks({}, top, want);
  }
}
