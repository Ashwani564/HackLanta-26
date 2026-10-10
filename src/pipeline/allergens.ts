import type { AllergenSource, Dish } from "../types.js";

/** The allergen names used in the catalog. Everything the user says is mapped onto these. */
export const CANONICAL_ALLERGENS = [
  "milk",
  "egg",
  "wheat",
  "soy",
  "tree_nuts",
  "peanuts",
  "shellfish",
  "fish",
  "sesame",
] as const;

const SYNONYMS: Record<string, string[]> = {
  milk: ["milk"],
  dairy: ["milk"],
  lactose: ["milk"],
  "lactose intolerant": ["milk"],
  cheese: ["milk"],
  egg: ["egg"],
  eggs: ["egg"],
  wheat: ["wheat"],
  gluten: ["wheat"],
  celiac: ["wheat"],
  coeliac: ["wheat"],
  soy: ["soy"],
  soya: ["soy"],
  soybean: ["soy"],
  soybeans: ["soy"],
  peanut: ["peanuts"],
  peanuts: ["peanuts"],
  "tree nut": ["tree_nuts"],
  "tree nuts": ["tree_nuts"],
  tree_nut: ["tree_nuts"],
  tree_nuts: ["tree_nuts"],
  almond: ["tree_nuts"],
  almonds: ["tree_nuts"],
  cashew: ["tree_nuts"],
  cashews: ["tree_nuts"],
  walnut: ["tree_nuts"],
  walnuts: ["tree_nuts"],
  pecan: ["tree_nuts"],
  pecans: ["tree_nuts"],
  pistachio: ["tree_nuts"],
  pistachios: ["tree_nuts"],
  hazelnut: ["tree_nuts"],
  hazelnuts: ["tree_nuts"],
  // "nuts" is ambiguous, so it means both.
  nut: ["tree_nuts", "peanuts"],
  nuts: ["tree_nuts", "peanuts"],
  shellfish: ["shellfish"],
  shrimp: ["shellfish"],
  crab: ["shellfish"],
  lobster: ["shellfish"],
  fish: ["fish"],
  seafood: ["fish", "shellfish"],
  sesame: ["sesame"],
};

export interface NormalizedAllergies {
  allergens: string[];
  /** Terms we do not recognize. They are never dropped: callers must filter on them as text. */
  unmapped: string[];
}

export function normalizeAllergies(terms: readonly string[]): NormalizedAllergies {
  const allergens = new Set<string>();
  const unmapped = new Set<string>();
  for (const raw of terms) {
    const term = raw.trim().toLowerCase().replace(/\s+/g, " ");
    if (!term) continue;
    const hit = SYNONYMS[term] ?? SYNONYMS[term.replace(/ allergy$/, "")];
    if (hit) hit.forEach((a) => allergens.add(a));
    else unmapped.add(term);
  }
  return { allergens: [...allergens].sort(), unmapped: [...unmapped].sort() };
}

/** Normalize a pipe-separated catalog cell into canonical allergens. Unknown tokens are kept as-is. */
export function parseCatalogAllergens(cell: string): string[] {
  const out = new Set<string>();
  for (const raw of cell.split("|")) {
    const token = raw.trim().toLowerCase();
    // "none" marks a deliberately empty list (the cell is not blank, so allergensKnown stays true).
    if (!token || token === "none") continue;
    const hit = SYNONYMS[token];
    if (hit) hit.forEach((a) => out.add(a));
    else out.add(token);
  }
  return [...out].sort();
}

/**
 * How much to trust a dish's allergen list.
 *  stated      = from the restaurant's own chart/ingredients/menu text
 *  unconfirmed = estimated or inferred by us. Never present as confirmed.
 *  unknown     = blank. Excluded for anyone with an allergy.
 */
export type AllergenConfidence = "stated" | "unconfirmed" | "unknown";

export function allergenConfidence(dish: Pick<Dish, "allergensKnown" | "allergenSource">): AllergenConfidence {
  if (!dish.allergensKnown) return "unknown";
  const source: AllergenSource = dish.allergenSource;
  return source === "chart" || source === "ingredients" || source === "menu_text" ? "stated" : "unconfirmed";
}

/**
 * Ingredient words that signal each allergen in a dish's name or description. The `allergens` cell can be wrong or
 * incomplete (457 rows are only estimated), so when an allergen is active we ALSO refuse dishes whose text mentions
 * it. Matching is by word start, so "peanut" hits "peanuts" and "egg" hits "eggplant". False positives are accepted;
 * a miss is not. Menu section names are not scanned: the scrape files items under unrelated sections.
 */
export const ALLERGEN_KEYWORDS: Record<string, string[]> = {
  peanuts: ["peanut", "satay", "groundnut"],
  tree_nuts: ["almond", "cashew", "walnut", "pecan", "pistachio", "hazelnut", "macadamia", "pine nut", "praline", "marzipan", "nutella", "nut", "nuts"],
  milk: ["milk", "cheese", "cream", "butter", "ghee", "paneer", "yogurt", "yoghurt", "dahi", "raita", "lassi", "custard", "whey", "mozzarella", "cheddar", "parmesan", "queso", "malai", "dairy"],
  egg: ["egg", "mayo", "mayonnaise", "aioli", "meringue"],
  wheat: ["wheat", "gluten", "flour", "bread", "naan", "roti", "paratha", "bagel", "croissant", "noodle", "pasta", "tortilla", "biscuit", "pita", "batter", "breaded", "panko", "dumpling", "shumai", "couscous", "brioche", "buns", "pastry", "seitan", "cracker", "crust", "waffle", "pancake", "muffin", "cookie", "cake"],
  soy: ["soy", "tofu", "tempeh", "edamame", "miso", "teriyaki", "tamari"],
  shellfish: ["shrimp", "prawn", "crab", "lobster", "crawfish", "crayfish", "scallop", "clam", "oyster", "mussel", "squid", "calamari"],
  fish: ["fish", "salmon", "tuna", "tilapia", "cod", "anchov", "sardine", "mahi", "catfish", "snapper", "whiting"],
  sesame: ["sesame", "tahini", "hummus", "benne"],
};

/** A dish that says "gluten free" in its own text is not rejected for wheat keywords alone (its allergen cell still applies). */
export const GLUTEN_FREE_CLAIM = "gluten[- ]free";

/**
 * Regex sources for the active allergens: `general` covers every allergen except wheat, `wheat` is separate
 * because it has the gluten-free exemption. Null when nothing applies.
 */
export function keywordPatterns(allergens: readonly string[], dialect: "js" | "pg"): { general: string | null; wheat: string | null } {
  const general = allergens.filter((a) => a !== "wheat").flatMap((a) => ALLERGEN_KEYWORDS[a] ?? []);
  const wheat = allergens.includes("wheat") ? (ALLERGEN_KEYWORDS.wheat ?? []) : [];
  return { general: termsPattern(general, dialect), wheat: termsPattern(wheat, dialect) };
}

export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * A case-insensitive regex source that matches any term at the start of a word ("peanut" hits
 * "peanuts"; "egg" also hits "eggplant", which is the safe direction to be wrong). Null if no terms.
 * Postgres spells word-start `\m`, JavaScript spells it `\b`.
 */
export function termsPattern(terms: readonly string[], dialect: "js" | "pg"): string | null {
  const clean = terms.map((t) => t.trim()).filter(Boolean);
  if (clean.length === 0) return null;
  const start = dialect === "pg" ? "\\m" : "\\b";
  return `${start}(${clean.map(escapeRegex).join("|")})`;
}
