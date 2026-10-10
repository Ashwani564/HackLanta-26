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
