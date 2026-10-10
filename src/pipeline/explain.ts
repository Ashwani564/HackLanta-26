import type { Candidate } from "../types.js";
import { converseTool } from "../llm/bedrock.js";

export interface Pick {
  dish: Candidate;
  reason: string;
}

interface RawPicks {
  picks?: { dish_id?: unknown; reason?: unknown }[];
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

const SYSTEM = `You pick up to 3 dishes for a group chat from a candidate list and write one short line for each.
Rules:
- Choose ONLY dish_id values from the list, copied exactly. Prefer variety across restaurants.
- Every candidate already passed everyone's dietary and allergy filters. Never say or imply anything is "safe", "allergen-free" or "free of" something.
- Never mention a person's health, allergies, diet or goals. If it helps, you may say it "works for everyone".
- Use ONLY facts present in the candidate's fields (dish, restaurant, category, description, price, calories, protein). Never invent ingredients, spice levels, flavors or preparation. If the description is empty, say only what the dish name and category already tell you.
- Plain text, no emoji.`;

// A reason that claims safety is replaced with a neutral line. Safety claims come from code, never the model.
const SAFETY_CLAIM = /\b(allergen[- ]?free|safe|free of|free from|guarantee|no (milk|dairy|egg|wheat|gluten|soy|nuts?|peanuts?|shellfish|fish|sesame))\b/i;

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
export function validatePicks(raw: RawPicks, ranked: readonly Candidate[], want = 3): Pick[] {
  const byId = new Map(ranked.map((c) => [c.dishId, c]));
  const picks: Pick[] = [];
  const used = new Set<string>();
  for (const p of raw.picks ?? []) {
    if (typeof p.dish_id !== "string") continue;
    const dish = byId.get(p.dish_id);
    if (!dish || used.has(dish.dishId)) continue;
    used.add(dish.dishId);
    picks.push({ dish, reason: cleanReason(p.reason, dish) });
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

export async function pickDishes(request: string, ranked: readonly Candidate[], want = 3): Promise<Pick[]> {
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
      system: SYSTEM,
      user: `Request: ${request}\n\nCandidates:\n${JSON.stringify(list)}`,
      toolName: "pick_dishes",
      toolDescription: "Return up to 3 chosen dishes with a one-line reason each.",
      schema: SCHEMA,
    });
    return validatePicks(raw, top, want);
  } catch {
    // If the model is down or returns garbage, the ranked list still produces a valid reply.
    return validatePicks({}, top, want);
  }
}
