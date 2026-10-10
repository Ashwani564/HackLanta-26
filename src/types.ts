export type AllergenSource = "chart" | "ingredients" | "menu_text" | "estimated" | "inferred" | "";

export const ITEM_KINDS = ["meal", "drink", "side", "dessert", "addon"] as const;
export type ItemKind = (typeof ITEM_KINDS)[number];

export interface Dish {
  dishId: string;
  restaurantId: string;
  restaurantName: string;
  placeId: string;
  lat: number;
  lng: number;
  dishName: string;
  description: string;
  category: string;
  /** Derived from `category`. Lets "I'm hungry" return meals and not $1 sauces. Not a safety field. */
  itemKind: ItemKind;
  /** Hand-tagged per restaurant (see data/cuisines.ts). Lets "Thai" and "not Mexican" work. */
  cuisine: string[];
  priceUsd: number | null;
  calories: number | null;
  proteinG: number | null;
  carbsG: number | null;
  fatG: number | null;
  sodiumMg: number | null;
  nutritionSource: string;
  /** Canonical allergen names (see allergens.ts). Empty means "none listed", NOT "none present". */
  allergens: string[];
  /** False when the allergens field was blank. Blank is unknown, never safe. */
  allergensKnown: boolean;
  allergenSource: AllergenSource;
  dietTags: string[];
}

/** Merged, code-enforced constraints for a request. Built from profiles + the message. */
export interface Constraints {
  /** Canonical allergens (already normalized). */
  allergens: string[];
  /** Free-text allergy terms we could not map to a canonical allergen. Matched against dish text. */
  unmappedAllergyTerms: string[];
  /** Required diets, canonical (vegan, vegetarian, gluten_free, halal, kosher). */
  diets: string[];
  budgetMaxUsd?: number;
  /** Words the user does not want ("mexican", "fries"). Matched against name, description, category, restaurant. */
  excludeTerms: string[];
}

export interface Candidate extends Dish {
  similarity: number;
}
