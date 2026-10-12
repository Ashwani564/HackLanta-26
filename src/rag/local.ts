// Menu search with no database: the catalog CSV in memory, ranked by word overlap instead of embeddings. Used when
// DB_CLUSTER_ARN isn't set, so the bot runs without AWS. The same code-side hard filters decide what anyone can eat.
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dedupeDishes, loadCatalog } from "../data/catalog.js";
import { filterDishes } from "../pipeline/filter.js";
import type { Candidate, Constraints, Dish, ItemKind } from "../types.js";

export const usingLocalCatalog = () => !process.env.DB_CLUSTER_ARN;

let dishes: Dish[] | undefined;

function catalogPath(): string {
  if (process.env.CATALOG_CSV) return process.env.CATALOG_CSV;
  // src/rag/local.ts -> repo root data/; also works from the bot's bundled output next to a copied data/ folder.
  const here = dirname(fileURLToPath(import.meta.url));
  for (const p of [resolve(here, "../../data/gsu_dishes.csv"), resolve(here, "../../../data/gsu_dishes.csv"), resolve(process.cwd(), "data/gsu_dishes.csv"), resolve(process.cwd(), "../data/gsu_dishes.csv")]) {
    if (existsSync(p)) return p;
  }
  throw new Error("menu catalog not found: set CATALOG_CSV to data/gsu_dishes.csv");
}

export function catalog(): Dish[] {
  return (dishes ??= dedupeDishes(loadCatalog(catalogPath())));
}

const words = (t: string) => new Set(t.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2));

/** Share of the query's words found in the dish text, 0..1. */
export function overlap(query: string, d: Dish): number {
  const q = words(query);
  if (q.size === 0) return 0;
  const text = words(`${d.dishName} ${d.description} ${d.category} ${d.cuisine.join(" ")} ${d.restaurantName}`);
  let hit = 0;
  for (const w of q) if (text.has(w)) hit++;
  return hit / q.size;
}

/** Same contract as the pgvector search: hard filters first, then the most relevant dishes. */
export function searchLocal(query: string, c: Constraints, limit = 40, kinds: readonly ItemKind[] = [], restaurantId?: string): Candidate[] {
  const scoped = catalog().filter((d) => (kinds.length === 0 || kinds.includes(d.itemKind)) && (!restaurantId || d.restaurantId === restaurantId));
  const { kept } = filterDishes(scoped, c);
  return kept
    .map((d) => ({ ...d, similarity: overlap(query, d) }))
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, Math.max(1, Math.min(Math.trunc(limit), 100)));
}

/** Restaurants with at least one dish this person can eat, like the SQL GROUP BY. */
export function restaurantsLocal(c: Constraints, kinds: readonly ItemKind[] = []) {
  const { kept } = filterDishes(catalog().filter((d) => kinds.length === 0 || kinds.includes(d.itemKind)), c);
  const by = new Map<string, Dish[]>();
  for (const d of kept) by.set(d.restaurantId, [...(by.get(d.restaurantId) ?? []), d]);
  return [...by.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([restaurantId, ds]) => {
      const prices = ds.map((d) => d.priceUsd).filter((p): p is number => p !== null);
      return {
        restaurantId,
        restaurantName: ds[0]!.restaurantName,
        lat: ds.reduce((s, d) => s + d.lat, 0) / ds.length,
        lng: ds.reduce((s, d) => s + d.lng, 0) / ds.length,
        cuisine: ds[0]!.cuisine,
        dishCount: ds.length,
        minPriceUsd: prices.length ? Math.min(...prices) : null,
        maxPriceUsd: prices.length ? Math.max(...prices) : null,
      };
    });
}
