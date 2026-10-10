/**
 * The scrape has no cuisine field, so "recommend Thai" and "not Mexican" had nothing to match.
 * This is a hand-written, per-restaurant tag list for the 9 GSU restaurants. Add a line when a restaurant is added.
 * Keep tags to what the restaurant itself says it serves.
 */
export const CUISINE_BY_RESTAURANT: Record<string, string[]> = {
  "india-eats": ["indian"],
  mangos: ["caribbean", "jamaican"],
  moes: ["mexican", "tex-mex"],
  "mr-fries-man": ["american", "fast food"],
  "queen-tea": ["taiwanese", "asian", "chinese"],
  saxbys: ["cafe", "coffeehouse"],
  starbucks: ["cafe", "coffeehouse"],
  "stir-house": ["asian", "stir fry"],
  "strikeout-wingz": ["american", "wings"],
};

export const cuisinesFor = (restaurantId: string): string[] => CUISINE_BY_RESTAURANT[restaurantId] ?? [];

export type MealName = "breakfast" | "lunch" | "dinner";

/** Coffee shops and drink counters: fine for breakfast or lunch, never suggested for dinner. */
const NOT_FOR_DINNER = new Set(["starbucks", "saxbys", "queen-tea"]);
export const servesMeal = (restaurantId: string, meal: MealName): boolean => !(meal === "dinner" && NOT_FOR_DINNER.has(restaurantId));

/** The meal it is at this time of day (minutes since local midnight). Dinner starts at 4:30 PM. */
export const mealAt = (minutes: number): MealName => (minutes < 10 * 60 + 30 ? "breakfast" : minutes < 16 * 60 + 30 ? "lunch" : "dinner");
