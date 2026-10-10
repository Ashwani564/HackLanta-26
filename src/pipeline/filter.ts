import type { Constraints, Dish } from "../types.js";
import { GLUTEN_FREE_CLAIM, hasRealAllergy, keywordPatterns, termsPattern } from "./allergens.js";

/**
 * Hard filters. Pure functions. The LLM never decides what is safe.
 * The same rules are pushed into SQL in rag/store.ts; this module is the second, authoritative check
 * that runs on whatever the database returned.
 */

export type DropReason = "allergen" | "allergen_text" | "allergen_unknown" | "allergy_text" | "diet" | "budget" | "excluded";

/** Diet requirement -> catalog tags that satisfy it. A dish must carry at least one. */
export function dietAcceptableTags(diet: string): string[] {
  const d = diet.trim().toLowerCase().replace(/[\s-]+/g, "_");
  switch (d) {
    case "vegan":
    case "plant_based":
      return ["vegan"];
    case "vegetarian":
    case "veggie":
      return ["vegetarian", "vegan"];
    case "gluten_free":
    case "gf":
      return ["gluten_free"];
    default:
      // halal, kosher, anything else: the dish must carry exactly that tag. No data means no results.
      return [d];
  }
}

function dishText(d: Pick<Dish, "dishName" | "description" | "category" | "restaurantName" | "cuisine">): string {
  return `${d.dishName} ${d.description} ${d.category} ${d.restaurantName} ${d.cuisine.join(" ")}`;
}

/** Does the dish's own name or description mention an ingredient of any active allergen? */
export function mentionsActiveAllergen(dish: Pick<Dish, "dishName" | "description">, allergens: readonly string[]): boolean {
  const text = `${dish.dishName} ${dish.description}`;
  const { general, wheat } = keywordPatterns(allergens, "js");
  if (general && new RegExp(general, "i").test(text)) return true;
  return !!wheat && new RegExp(wheat, "i").test(text) && !new RegExp(GLUTEN_FREE_CLAIM, "i").test(text);
}

export function hardFilterReason(dish: Dish, c: Constraints): DropReason | null {
  const hasAllergy = c.allergens.length > 0 || c.unmappedAllergyTerms.length > 0;
  if (hasAllergy) {
    // Blank allergens field means unknown. Unknown is excluded for anyone with a real allergy. Beef and pork are
    // found from the dish text alone, so avoiding them does not need the allergen cell to be known.
    if (hasRealAllergy(c) && !dish.allergensKnown) return "allergen_unknown";
    if (dish.allergens.some((a) => c.allergens.includes(a))) return "allergen";
    if (mentionsActiveAllergen(dish, c.allergens)) return "allergen_text";
    const pattern = termsPattern(c.unmappedAllergyTerms, "js");
    if (pattern && new RegExp(pattern, "i").test(`${dish.dishName} ${dish.description} ${dish.category}`)) {
      return "allergy_text";
    }
  }

  for (const diet of c.diets) {
    const ok = dietAcceptableTags(diet);
    if (!dish.dietTags.some((t) => ok.includes(t))) return "diet";
  }

  if (c.budgetMaxUsd !== undefined) {
    // Unknown price cannot be shown to fit a budget, so it is excluded when a budget is set.
    if (dish.priceUsd === null || dish.priceUsd > c.budgetMaxUsd) return "budget";
  }

  const exclude = termsPattern(c.excludeTerms, "js");
  if (exclude && new RegExp(exclude, "i").test(dishText(dish))) return "excluded";

  return null;
}

export interface FilterResult<T extends Dish> {
  kept: T[];
  dropped: Record<DropReason, number>;
}

export function filterDishes<T extends Dish>(dishes: readonly T[], c: Constraints): FilterResult<T> {
  const dropped: Record<DropReason, number> = {
    allergen: 0,
    allergen_text: 0,
    allergen_unknown: 0,
    allergy_text: 0,
    diet: 0,
    budget: 0,
    excluded: 0,
  };
  const kept: T[] = [];
  for (const dish of dishes) {
    const reason = hardFilterReason(dish, c);
    if (reason) dropped[reason]++;
    else kept.push(dish);
  }
  return { kept, dropped };
}

export function haversineKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(h));
}
