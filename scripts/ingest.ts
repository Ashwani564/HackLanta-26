/**
 * Load data/gsu_dishes.csv into the pgvector table: create the schema, embed every dish, upsert.
 * Safe to re-run: rows are upserted by dish_id. Re-run after the CSV changes or the embedding model changes.
 *
 *   npm run ingest
 */
import { dedupeDishes, loadCatalog } from "../src/data/catalog.js";
import { embedAll } from "../src/rag/embed.js";
import { embeddingText } from "../src/rag/embedText.js";
import { countDishes, ensureSchema, pruneDishes, upsertDishes } from "../src/rag/store.js";

const path = process.env.CATALOG_CSV ?? "data/gsu_dishes.csv";
const all = loadCatalog(path);
const dishes = dedupeDishes(all);
const unknown = dishes.filter((d) => !d.allergensKnown).length;
console.log(`Loaded ${all.length} rows from ${path}; ${dishes.length} after collapsing exact duplicates (${unknown} with unknown allergens)`);

console.log("Creating schema (waits up to ~30 s if the cluster is paused)...");
await ensureSchema();

const texts = dishes.map(embeddingText);
console.log(`Embedding ${texts.length} dishes with ${process.env.EMBEDDING_MODEL_ID}...`);
const t0 = Date.now();
const embeddings = await embedAll(texts);
console.log(`  done in ${((Date.now() - t0) / 1000).toFixed(1)} s`);

console.log("Upserting...");
await upsertDishes(dishes.map((dish, i) => ({ dish, embedText: texts[i]!, embedding: embeddings[i]! })));

await pruneDishes(dishes.map((d) => d.dishId));
const n = await countDishes();
console.log(`Table now holds ${n} dishes.`);
if (n !== dishes.length) {
  console.error(`Expected ${dishes.length} rows. Rows from an older CSV may still be present.`);
  process.exitCode = 1;
}
