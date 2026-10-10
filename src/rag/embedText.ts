import type { Dish } from "../types.js";

/**
 * The text we embed for a dish. Allergens are deliberately NOT included: embeddings cannot
 * express negation, and safety is enforced by hard filters, not by similarity.
 * Nutrition numbers are turned into plain-language labels so "high protein" or "light" queries land.
 */
export function nutritionLabels(d: Pick<Dish, "calories" | "proteinG" | "sodiumMg">): string[] {
  const labels: string[] = [];
  if (d.proteinG !== null && d.proteinG >= 25) labels.push("high protein");
  if (d.calories !== null && d.calories <= 400) labels.push("light, low calorie");
  if (d.calories !== null && d.calories >= 900) labels.push("big, hearty, indulgent");
  if (d.sodiumMg !== null && d.sodiumMg <= 500) labels.push("low sodium");
  return labels;
}

export function embeddingText(d: Dish): string {
  const parts = [
    `${d.dishName} at ${d.restaurantName}`,
    d.cuisine.length > 0 && `Cuisine: ${d.cuisine.join(", ")}`,
    d.category && `Category: ${d.category}`,
    d.description,
    d.dietTags.length > 0 && `Diet: ${d.dietTags.join(", ").replace(/_/g, " ")}`,
    ...nutritionLabels(d),
  ];
  return parts.filter(Boolean).join(". ");
}
