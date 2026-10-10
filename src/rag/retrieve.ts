import type { Candidate, Constraints, ItemKind } from "../types.js";
import { filterDishes, type DropReason } from "../pipeline/filter.js";
import { embed } from "./embed.js";
import { searchDishes } from "./store.js";

export interface RetrievalResult {
  candidates: Candidate[];
  /** Rows the database returned that the code-side filter rejected. Always expected to be empty. */
  leaked: Record<DropReason, number>;
}

/**
 * Semantic retrieval with hard filters. SQL applies the filters, then the pure filter re-checks every row
 * before anything is handed on. If the two ever disagree, the code-side result wins and `leaked` is non-zero.
 */
export async function retrieve(
  query: string,
  constraints: Constraints,
  opts: { limit?: number; kinds?: readonly ItemKind[]; restaurantId?: string } = {},
): Promise<RetrievalResult> {
  const rows = await searchDishes(await embed(query), constraints, opts.limit ?? 40, opts.kinds ?? [], opts.restaurantId);
  const { kept, dropped } = filterDishes(rows, constraints);
  return { candidates: kept, leaked: dropped };
}
