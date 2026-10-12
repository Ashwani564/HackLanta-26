import {
  BatchExecuteStatementCommand,
  ExecuteStatementCommand,
  RDSDataClient,
  type SqlParameter,
} from "@aws-sdk/client-rds-data";
import { ITEM_KINDS, type AllergenSource, type Candidate, type Constraints, type Dish, type ItemKind } from "../types.js";
import { dietAcceptableTags } from "../pipeline/filter.js";
import { ALLERGEN_KEYWORDS, GLUTEN_FREE_CLAIM, hasRealAllergy, keywordPatterns, termsPattern } from "../pipeline/allergens.js";
import { EMBEDDING_DIMENSIONS } from "./embed.js";
import { restaurantsLocal, usingLocalCatalog } from "./local.js";

/**
 * pgvector access through the RDS Data API (HTTPS, no VPC or connection pool needed in Lambda).
 * Every value reaches Postgres as a bound parameter. User text is never concatenated into SQL.
 */

let client: RDSDataClient | undefined;

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
}

const target = () => ({
  resourceArn: requireEnv("DB_CLUSTER_ARN"),
  secretArn: requireEnv("DB_SECRET_ARN"),
  database: process.env.DB_NAME ?? "dining",
});

type Param = string | number | null;

function toParams(params: Record<string, Param>): SqlParameter[] {
  return Object.entries(params).map(([name, v]) => ({
    name,
    value: v === null ? { isNull: true } : { stringValue: String(v) },
  }));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A paused Serverless v2 cluster answers with a "resuming" error for ~15 s. Retry; never call this from the webhook path. */
async function withResume<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const text = `${(err as Error).name} ${(err as Error).message}`;
      if (attempt < 8 && /resum|Communications link failure|DatabaseUnavailable/i.test(text)) {
        await sleep(4000);
        continue;
      }
      throw err;
    }
  }
}

function db(): RDSDataClient {
  return (client ??= new RDSDataClient({ region: process.env.AWS_REGION ?? "us-east-2" }));
}

async function query<T>(sql: string, params: Record<string, Param> = {}): Promise<T[]> {
  const res = await withResume(() =>
    db().send(new ExecuteStatementCommand({ ...target(), sql, parameters: toParams(params), formatRecordsAs: "JSON" })),
  );
  return res.formattedRecords ? (JSON.parse(res.formattedRecords) as T[]) : [];
}

export const SCHEMA_STATEMENTS = [
  "CREATE EXTENSION IF NOT EXISTS vector",
  `CREATE TABLE IF NOT EXISTS dishes (
    dish_id text PRIMARY KEY,
    restaurant_id text NOT NULL,
    restaurant_name text NOT NULL,
    place_id text,
    lat double precision NOT NULL,
    lng double precision NOT NULL,
    dish_name text NOT NULL,
    description text,
    category text,
    price_usd numeric,
    calories numeric,
    protein_g numeric,
    carbs_g numeric,
    fat_g numeric,
    sodium_mg numeric,
    nutrition_source text,
    allergens text[] NOT NULL DEFAULT '{}',
    allergens_known boolean NOT NULL,
    allergen_source text,
    diet_tags text[] NOT NULL DEFAULT '{}',
    embed_text text NOT NULL,
    embedding vector(${EMBEDDING_DIMENSIONS}) NOT NULL
  )`,
  // ~825 rows: an exact scan is instant and always returns k rows. An ANN index plus a selective
  // WHERE can silently return fewer than k, so there is deliberately no HNSW index here.
  "CREATE INDEX IF NOT EXISTS dishes_restaurant_idx ON dishes (restaurant_id)",
  "ALTER TABLE dishes ADD COLUMN IF NOT EXISTS item_kind text NOT NULL DEFAULT 'meal'",
  "ALTER TABLE dishes ADD COLUMN IF NOT EXISTS cuisine text[] NOT NULL DEFAULT '{}'",
  "ALTER TABLE dishes ADD COLUMN IF NOT EXISTS price_source text",
  "ALTER TABLE dishes ADD COLUMN IF NOT EXISTS diet_source text",
  // Dropped first: CREATE OR REPLACE VIEW cannot insert columns in the middle.
  "DROP VIEW IF EXISTS dish_allergen_chart",
  // One row per dish, one boolean per major allergen plus diet flags, for reading the chart in plain SQL.
  // allergen_info: how far to trust it (chart/ingredients/menu_text = stated; inferred/estimated = our estimate;
  // unknown = blank, never treated as safe).
  `CREATE OR REPLACE VIEW dish_allergen_chart AS
    SELECT dish_id, restaurant_name, dish_name, category, item_kind, price_usd, price_source,
      CASE WHEN NOT allergens_known THEN 'unknown'
           WHEN allergen_source IN ('chart', 'ingredients', 'menu_text') THEN 'stated'
           ELSE 'estimated' END AS allergen_info,
      allergen_source,
      allergens_known AND 'milk' = ANY(allergens) AS milk,
      allergens_known AND 'egg' = ANY(allergens) AS egg,
      allergens_known AND 'wheat' = ANY(allergens) AS wheat,
      allergens_known AND 'soy' = ANY(allergens) AS soy,
      allergens_known AND 'tree_nuts' = ANY(allergens) AS tree_nuts,
      allergens_known AND 'peanuts' = ANY(allergens) AS peanuts,
      allergens_known AND 'fish' = ANY(allergens) AS fish,
      allergens_known AND 'shellfish' = ANY(allergens) AS shellfish,
      allergens_known AND 'sesame' = ANY(allergens) AS sesame,
      allergens_known AND ('tree_nuts' = ANY(allergens) OR 'peanuts' = ANY(allergens)) AS nuts,
      -- Beef and pork are read from the dish name and description with the same keyword list the filter uses.
      -- They are inferred, never from a chart, so they are not gated on allergens_known.
      (dish_name || ' ' || COALESCE(description, '')) ~* '${termsPattern(ALLERGEN_KEYWORDS.beef!, "pg")}' AS beef,
      (dish_name || ' ' || COALESCE(description, '')) ~* '${termsPattern(ALLERGEN_KEYWORDS.pork!, "pg")}' AS pork,
      'vegan' = ANY(diet_tags) AS vegan,
      'vegetarian' = ANY(diet_tags) OR 'vegan' = ANY(diet_tags) AS vegetarian,
      'halal' = ANY(diet_tags) AS halal,
      diet_source
    FROM dishes`,
];

export async function ensureSchema(): Promise<void> {
  for (const sql of SCHEMA_STATEMENTS) await query(sql);
}

const UPSERT = `INSERT INTO dishes (
    dish_id, restaurant_id, restaurant_name, place_id, lat, lng, dish_name, description, category, item_kind, cuisine,
    price_usd, price_source, diet_source, calories, protein_g, carbs_g, fat_g, sodium_mg, nutrition_source,
    allergens, allergens_known, allergen_source, diet_tags, embed_text, embedding
  ) VALUES (
    :dish_id, :restaurant_id, :restaurant_name, :place_id, CAST(:lat AS double precision), CAST(:lng AS double precision),
    :dish_name, :description, :category, :item_kind,
    COALESCE(string_to_array(NULLIF(:cuisine, ''), '|'), '{}'),
    CAST(:price_usd AS numeric), NULLIF(:price_source, ''), NULLIF(:diet_source, ''), CAST(:calories AS numeric), CAST(:protein_g AS numeric), CAST(:carbs_g AS numeric),
    CAST(:fat_g AS numeric), CAST(:sodium_mg AS numeric), :nutrition_source,
    COALESCE(string_to_array(NULLIF(:allergens, ''), '|'), '{}'), CAST(:allergens_known AS boolean), :allergen_source,
    COALESCE(string_to_array(NULLIF(:diet_tags, ''), '|'), '{}'), :embed_text, CAST(:embedding AS vector)
  )
  ON CONFLICT (dish_id) DO UPDATE SET
    restaurant_id = EXCLUDED.restaurant_id, restaurant_name = EXCLUDED.restaurant_name, place_id = EXCLUDED.place_id,
    lat = EXCLUDED.lat, lng = EXCLUDED.lng, dish_name = EXCLUDED.dish_name, description = EXCLUDED.description,
    category = EXCLUDED.category, item_kind = EXCLUDED.item_kind, cuisine = EXCLUDED.cuisine, price_usd = EXCLUDED.price_usd,
    price_source = EXCLUDED.price_source, diet_source = EXCLUDED.diet_source, calories = EXCLUDED.calories,
    protein_g = EXCLUDED.protein_g, carbs_g = EXCLUDED.carbs_g, fat_g = EXCLUDED.fat_g, sodium_mg = EXCLUDED.sodium_mg,
    nutrition_source = EXCLUDED.nutrition_source, allergens = EXCLUDED.allergens,
    allergens_known = EXCLUDED.allergens_known, allergen_source = EXCLUDED.allergen_source,
    diet_tags = EXCLUDED.diet_tags, embed_text = EXCLUDED.embed_text, embedding = EXCLUDED.embedding`;

const vectorLiteral = (v: number[]) => `[${v.join(",")}]`;

export async function upsertDishes(rows: { dish: Dish; embedText: string; embedding: number[] }[]): Promise<void> {
  const BATCH = 20;
  for (let i = 0; i < rows.length; i += BATCH) {
    const parameterSets = rows.slice(i, i + BATCH).map(({ dish: d, embedText, embedding }) =>
      toParams({
        dish_id: d.dishId,
        restaurant_id: d.restaurantId,
        restaurant_name: d.restaurantName,
        place_id: d.placeId,
        lat: d.lat,
        lng: d.lng,
        dish_name: d.dishName,
        description: d.description,
        category: d.category,
        item_kind: d.itemKind,
        cuisine: d.cuisine.join("|"),
        price_usd: d.priceUsd,
        price_source: d.priceSource ?? "",
        diet_source: d.dietSource ?? "",
        calories: d.calories,
        protein_g: d.proteinG,
        carbs_g: d.carbsG,
        fat_g: d.fatG,
        sodium_mg: d.sodiumMg,
        nutrition_source: d.nutritionSource,
        allergens: d.allergens.join("|"),
        allergens_known: String(d.allergensKnown),
        allergen_source: d.allergenSource,
        diet_tags: d.dietTags.join("|"),
        embed_text: embedText,
        embedding: vectorLiteral(embedding),
      }),
    );
    await withResume(() => db().send(new BatchExecuteStatementCommand({ ...target(), sql: UPSERT, parameterSets })));
  }
}

/** Remove rows that are no longer in the catalog. Run after upserting so readers never see an empty table. */
export async function pruneDishes(keepIds: readonly string[]): Promise<void> {
  await query("DELETE FROM dishes WHERE NOT (dish_id = ANY(string_to_array(:ids, '|')))", { ids: keepIds.join("|") });
}

export async function countDishes(): Promise<number> {
  const [row] = await query<{ n: number }>("SELECT count(*)::int AS n FROM dishes");
  return row?.n ?? 0;
}

interface Row {
  dish_id: string;
  restaurant_id: string;
  restaurant_name: string;
  place_id: string | null;
  lat: number;
  lng: number;
  dish_name: string;
  description: string | null;
  category: string | null;
  item_kind: string;
  cuisine: string;
  price_usd: number | null;
  price_source: string | null;
  diet_source: string | null;
  calories: number | null;
  protein_g: number | null;
  carbs_g: number | null;
  fat_g: number | null;
  sodium_mg: number | null;
  nutrition_source: string | null;
  allergens: string;
  allergens_known: boolean;
  allergen_source: string | null;
  diet_tags: string;
  similarity: number;
}

const pipeList = (s: string | null) => (s ? s.split("|").filter(Boolean) : []);

export function candidateFromRow(r: Row): Candidate {
  return {
    dishId: r.dish_id,
    restaurantId: r.restaurant_id,
    restaurantName: r.restaurant_name,
    placeId: r.place_id ?? "",
    lat: Number(r.lat),
    lng: Number(r.lng),
    dishName: r.dish_name,
    description: r.description ?? "",
    category: r.category ?? "",
    itemKind: (ITEM_KINDS as readonly string[]).includes(r.item_kind) ? (r.item_kind as ItemKind) : "meal",
    cuisine: pipeList(r.cuisine),
    priceUsd: r.price_usd === null ? null : Number(r.price_usd),
    priceSource: r.price_source ?? "",
    calories: r.calories === null ? null : Number(r.calories),
    proteinG: r.protein_g === null ? null : Number(r.protein_g),
    carbsG: r.carbs_g === null ? null : Number(r.carbs_g),
    fatG: r.fat_g === null ? null : Number(r.fat_g),
    sodiumMg: r.sodium_mg === null ? null : Number(r.sodium_mg),
    nutritionSource: r.nutrition_source ?? "",
    allergens: pipeList(r.allergens),
    allergensKnown: r.allergens_known,
    allergenSource: (r.allergen_source ?? "") as AllergenSource,
    dietTags: pipeList(r.diet_tags),
    dietSource: r.diet_source ?? "",
    similarity: Number(r.similarity),
  };
}

const NAME_DESC = "(dish_name || ' ' || COALESCE(description, ''))";
const TEXT = "(dish_name || ' ' || COALESCE(description, '') || ' ' || COALESCE(category, ''))";

/**
 * The hard filters, shared by dish search and the restaurant list so the two can never disagree about
 * what a person can eat. `kinds` and `restaurantId` are not safety filters; they only narrow the scope.
 */
function buildWhere(
  c: Constraints,
  kinds: readonly ItemKind[] = [],
  restaurantId?: string,
): { where: string[]; params: Record<string, Param> } {
  const where: string[] = [];
  const params: Record<string, Param> = {};

  // Not a safety filter: keeps sauces and drinks out of "I'm hungry". Empty means any kind.
  const validKinds = kinds.filter((k) => (ITEM_KINDS as readonly string[]).includes(k));
  if (validKinds.length > 0) {
    where.push("item_kind = ANY(string_to_array(:kinds, ','))");
    params.kinds = validKinds.join(",");
  }
  if (restaurantId) {
    where.push("restaurant_id = :restaurant_id");
    params.restaurant_id = restaurantId;
  }

  // Beef and pork are matched on dish text only, so they alone do not require a known allergen cell.
  if (hasRealAllergy(c)) where.push("allergens_known");
  if (c.allergens.length > 0) {
    where.push("NOT (allergens && string_to_array(:allergens, ','))");
    params.allergens = c.allergens.join(",");
  }
  const kw = keywordPatterns(c.allergens, "pg");
  if (kw.general) {
    where.push(`NOT (${NAME_DESC} ~* :allergen_kw)`);
    params.allergen_kw = kw.general;
  }
  if (kw.wheat) {
    where.push(`NOT (${NAME_DESC} ~* :allergen_kw_wheat AND NOT ${NAME_DESC} ~* '${GLUTEN_FREE_CLAIM}')`);
    params.allergen_kw_wheat = kw.wheat;
  }
  const allergyText = termsPattern(c.unmappedAllergyTerms, "pg");
  if (allergyText) {
    where.push(`NOT (${TEXT} ~* :allergy_text)`);
    params.allergy_text = allergyText;
  }
  c.diets.forEach((diet, i) => {
    where.push(`diet_tags && string_to_array(:diet_${i}, ',')`);
    params[`diet_${i}`] = dietAcceptableTags(diet).join(",");
  });
  if (c.budgetMaxUsd !== undefined) {
    where.push("price_usd IS NOT NULL AND price_usd <= CAST(:budget AS numeric)");
    params.budget = c.budgetMaxUsd;
  }
  const exclude = termsPattern(c.excludeTerms, "pg");
  if (exclude) {
    where.push(`NOT ((${TEXT} || ' ' || restaurant_name || ' ' || array_to_string(cuisine, ' ')) ~* :exclude)`);
    params.exclude = exclude;
  }
  return { where, params };
}

/**
 * Build the retrieval query. Hard filters are in the WHERE clause, so a dish that fails them can never
 * be returned however similar it is. Similarity only orders what survives.
 */
export function buildSearchSql(
  c: Constraints,
  limit: number,
  kinds: readonly ItemKind[] = [],
  restaurantId?: string,
): { sql: string; params: Record<string, Param> } {
  const { where, params } = buildWhere(c, kinds, restaurantId);
  const sql = `SELECT dish_id, restaurant_id, restaurant_name, place_id, lat, lng, dish_name, description, category, item_kind,
      array_to_string(cuisine, '|') AS cuisine,
      price_usd, price_source, calories, protein_g, carbs_g, fat_g, sodium_mg, nutrition_source,
      array_to_string(allergens, '|') AS allergens, allergens_known, allergen_source,
      array_to_string(diet_tags, '|') AS diet_tags, diet_source,
      1 - (embedding <=> CAST(:q AS vector)) AS similarity
    FROM dishes
    ${where.length > 0 ? `WHERE ${where.join("\n      AND ")}` : ""}
    ORDER BY embedding <=> CAST(:q AS vector)
    LIMIT ${Math.max(1, Math.min(Math.trunc(limit), 100))}`;
  return { sql, params };
}

export async function searchDishes(
  queryEmbedding: number[],
  c: Constraints,
  limit = 40,
  kinds: readonly ItemKind[] = [],
  restaurantId?: string,
): Promise<Candidate[]> {
  const { sql, params } = buildSearchSql(c, limit, kinds, restaurantId);
  const rows = await query<Row>(sql, { ...params, q: vectorLiteral(queryEmbedding) });
  return rows.map(candidateFromRow);
}

export interface RestaurantSummary {
  restaurantId: string;
  restaurantName: string;
  lat: number;
  lng: number;
  cuisine: string[];
  /** How many dishes passed the hard filters. A restaurant with 0 never appears. */
  dishCount: number;
  minPriceUsd: number | null;
  maxPriceUsd: number | null;
}

/** Same WHERE as dish search, grouped by restaurant: only restaurants with at least one dish this person can eat. */
export function buildRestaurantsSql(c: Constraints, kinds: readonly ItemKind[] = []): { sql: string; params: Record<string, Param> } {
  const { where, params } = buildWhere(c, kinds);
  const sql = `SELECT restaurant_id, max(restaurant_name) AS restaurant_name, avg(lat) AS lat, avg(lng) AS lng,
      array_to_string(max(cuisine), '|') AS cuisine, count(*)::int AS dish_count,
      min(price_usd) AS min_price, max(price_usd) AS max_price
    FROM dishes
    ${where.length > 0 ? `WHERE ${where.join("\n      AND ")}` : ""}
    GROUP BY restaurant_id
    ORDER BY restaurant_id`;
  return { sql, params };
}

export async function listRestaurants(c: Constraints, kinds: readonly ItemKind[] = []): Promise<RestaurantSummary[]> {
  if (usingLocalCatalog()) return restaurantsLocal(c, kinds);
  const { sql, params } = buildRestaurantsSql(c, kinds);
  const rows = await query<{
    restaurant_id: string; restaurant_name: string; lat: number; lng: number; cuisine: string | null;
    dish_count: number; min_price: number | null; max_price: number | null;
  }>(sql, params);
  return rows.map((r) => ({
    restaurantId: r.restaurant_id,
    restaurantName: r.restaurant_name,
    lat: Number(r.lat),
    lng: Number(r.lng),
    cuisine: pipeList(r.cuisine),
    dishCount: r.dish_count,
    minPriceUsd: r.min_price === null ? null : Number(r.min_price),
    maxPriceUsd: r.max_price === null ? null : Number(r.max_price),
  }));
}

/** Fire-and-forget: wakes a paused Serverless v2 cluster (~15-20 s) while the user is still busy sharing a location. */
export function warmDb(): void {
  if (usingLocalCatalog()) return;
  query("SELECT 1").catch(() => {});
}
