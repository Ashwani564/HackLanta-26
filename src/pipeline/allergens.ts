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
  // Not allergens: foods people avoid for diet, religion or health. Detected from dish name and description only
  // (no chart lists them), so they are never "stated" data and never require a known allergen cell.
  "beef",
  "pork",
] as const;

/** The food-avoidances above. Everything else in CANONICAL_ALLERGENS is a real allergen. */
export const MEAT_AVOIDANCES: readonly string[] = ["beef", "pork"];
export const isRealAllergen = (a: string) => !MEAT_AVOIDANCES.includes(a);

/** True if the constraints include a real allergen (or an unmapped allergy term, which we treat as real). */
export const hasRealAllergy = (c: { allergens: readonly string[]; unmappedAllergyTerms: readonly string[] }) =>
  c.allergens.some(isRealAllergen) || c.unmappedAllergyTerms.length > 0;

/** "no pork", "pork-free", "no_beef", "red meat" -> the meats to avoid. Null when the term is something else. */
export function meatAvoidance(term: string): string[] | null {
  const t = term.trim().toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ").replace(/^(no|non|without) /, "").replace(/ free$/, "");
  if (t === "pork" || t === "beef") return [t];
  return t === "red meat" ? ["beef", "pork"] : null;
}

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
  beef: ["beef"],
  "no beef": ["beef"],
  pork: ["pork"],
  "no pork": ["pork"],
  "red meat": ["beef", "pork"],
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
    const hit = SYNONYMS[term] ?? SYNONYMS[term.replace(/ allergy$/, "")] ?? (meatAvoidance(term) ? meatAvoidance(term)! : undefined);
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
  // Superset on purpose (burgers and patties count as beef, "ham" also catches hamburger): a miss is worse than an extra drop.
  beef: ["beef", "steak", "burger", "cheeseburger", "hamburger", "smashburger", "brisket", "meatball", "ribeye", "sirloin", "cheesesteak", "philly", "short rib", "oxtail", "bulgogi", "veal", "patty", "patties", "gyro", "kofta", "chili con carne"],
  pork: ["pork", "bacon", "ham", "sausage", "pepperoni", "prosciutto", "salami", "chorizo", "carnitas", "pancetta", "bratwurst", "hot dog", "ribs", "lard", "chashu", "char siu", "gammon", "pig", "spam", "pulled pork"],
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
