import { readFileSync } from "node:fs";
import type { AllergenSource, Dish, ItemKind } from "../types.js";
import { parseCatalogAllergens } from "../pipeline/allergens.js";
import { cuisinesFor } from "./cuisines.js";

/** Minimal RFC 4180 parser: quoted fields, escaped quotes, newlines inside quotes. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.some((c) => c !== "")) rows.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field);
  if (row.some((c) => c !== "")) rows.push(row);
  return rows;
}

/** Menu section -> what kind of item it is. Order matters: add-ons are checked before drinks and sides. */
export function classifyKind(category: string, dishName = ""): ItemKind {
  const c = category.toLowerCase();
  // Plain accompaniments are scraped into every menu section as a required choice; they are not meals.
  if (/^(plain |brown |white |basmati |steamed |jeera )?rice$/i.test(dishName.trim())) return "side";
  if (/sauce|dressing|add-?ons?|extras?|topping|condiment|relish/.test(c)) return "addon";
  if (/dessert|treat/.test(c)) return "dessert";
  if (/beverage|drink|coffee|espresso|\bteas?\b|frappuccino|latte|frolatte|chai|matcha|refresher|smoothie|juice|lemonade|hot chocolate|cold brew|decaf|yogurt/.test(c)) {
    return "drink";
  }
  if (/\bsides?\b|dips?\b|dippers|bases|bakery|snacks?|\bapps\b|appetizers|dim sum|breads?/.test(c)) return "side";
  return "meal";
}

const num = (s: string | undefined): number | null => {
  if (s === undefined || s.trim() === "") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};

const list = (s: string | undefined): string[] =>
  (s ?? "")
    .split("|")
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);

export function dishesFromCsv(text: string): Dish[] {
  const [header, ...rows] = parseCsv(text);
  if (!header) throw new Error("catalog CSV is empty");
  const col = new Map(header.map((h, i) => [h.trim(), i]));
  const required = ["dish_id", "restaurant_id", "restaurant_name", "dish_name", "lat", "lng", "allergens", "allergen_source"];
  for (const name of required) if (!col.has(name)) throw new Error(`catalog CSV missing column: ${name}`);

  const seen = new Set<string>();
  return rows.map((r, line) => {
    const get = (name: string) => (r[col.get(name) ?? -1] ?? "").trim();
    const dishId = get("dish_id");
    if (!dishId) throw new Error(`catalog row ${line + 2}: empty dish_id`);
    if (seen.has(dishId)) throw new Error(`catalog row ${line + 2}: duplicate dish_id ${dishId}`);
    seen.add(dishId);
    const lat = num(get("lat"));
    const lng = num(get("lng"));
    if (lat === null || lng === null) throw new Error(`catalog row ${line + 2}: missing coordinates for ${dishId}`);
    const allergenCell = get("allergens");
    return {
      dishId,
      restaurantId: get("restaurant_id"),
      restaurantName: get("restaurant_name"),
      placeId: get("place_id"),
      lat,
      lng,
      dishName: get("dish_name"),
      description: get("description"),
      category: get("category"),
      itemKind: classifyKind(get("category"), get("dish_name")),
      cuisine: cuisinesFor(get("restaurant_id")),
      priceUsd: num(get("price_usd")),
      calories: num(get("calories")),
      proteinG: num(get("protein_g")),
      carbsG: num(get("carbs_g")),
      fatG: num(get("fat_g")),
      sodiumMg: num(get("sodium_mg")),
      nutritionSource: get("nutrition_source"),
      allergens: parseCatalogAllergens(allergenCell),
      // Blank is unknown. Never fill a blank with a guess.
      allergensKnown: allergenCell !== "",
      allergenSource: get("allergen_source") as AllergenSource,
      dietTags: list(get("diet_tags")),
    };
  });
}

/**
 * The scrape lists some items under several menu sections (India Eats has 8 copies of "Plain Rice").
 * Collapse copies that agree on everything that matters, keeping the first. Copies that differ in
 * allergens, diet, price or description are different facts and are all kept.
 */
export function dedupeDishes(dishes: readonly Dish[]): Dish[] {
  const seen = new Set<string>();
  const out: Dish[] = [];
  for (const d of dishes) {
    const key = [
      d.restaurantId,
      d.dishName.trim().toLowerCase(),
      d.description.trim().toLowerCase(),
      d.priceUsd,
      d.allergensKnown ? d.allergens.join("|") : "?",
      d.dietTags.join("|"),
    ].join("¦");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(d);
  }
  return out;
}

export function loadCatalog(path: string): Dish[] {
  return dishesFromCsv(readFileSync(path, "utf8"));
}
