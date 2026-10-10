import type { Candidate, Constraints, ItemKind } from "../types.js";
import { retrieve } from "../rag/retrieve.js";
import { pickDishes, type Pick } from "./explain.js";
import { formatReply } from "./format.js";
import type { ParsedMessage } from "./parse.js";
import { retrievalKinds, retrievalQuery } from "./route.js";
import { rankDishes } from "./score.js";
import type { DropReason } from "./filter.js";

export interface Recommendation {
  reply: string;
  picks: Pick[];
  candidates: Candidate[];
  /** Rows SQL returned that the code-side filter rejected. Expected to be empty; non-zero is a bug to investigate. */
  leaked: Record<DropReason, number>;
  kinds: ItemKind[];
  /** True when nothing matched the requested kind and we widened to every kind. */
  widened: boolean;
}

/**
 * retrieve -> rank -> pick 3 -> format. Shared by the worker, the CLI and the eval so they cannot drift.
 * If the requested kind (usually "meal") has no safe matches, search every kind before giving up,
 * and say so, because a side dish that fits is better than an empty reply.
 */
export async function recommend(
  request: string,
  parsed: ParsedMessage,
  constraints: Constraints,
  opts: { lastQuery?: string; origin?: { lat: number; lng: number }; groupChat?: boolean } = {},
): Promise<Recommendation> {
  const query = retrievalQuery(parsed, opts.lastQuery);
  let kinds = retrievalKinds(parsed);
  let result = await retrieve(query, constraints, { kinds });
  let widened = false;
  if (result.candidates.length === 0 && kinds.length > 0) {
    kinds = [];
    widened = true;
    result = await retrieve(query, constraints, { kinds });
  }

  const goals = parsed.goal ? [parsed.goal] : [];
  const ranked = rankDishes(result.candidates, {
    goals,
    ...(constraints.budgetMaxUsd !== undefined && { budgetMaxUsd: constraints.budgetMaxUsd }),
    ...(opts.origin && { origin: opts.origin }),
  });
  const picks = await pickDishes(request, ranked);
  const body = formatReply(picks, constraints, {
    ...(opts.origin && { origin: opts.origin }),
    ...(opts.groupChat !== undefined && { groupChat: opts.groupChat }),
  });
  const reply = widened && picks.length > 0 ? `No full meals matched, so here are the closest options:\n${body}` : body;
  return { reply, picks, candidates: result.candidates, leaked: result.leaked, kinds, widened };
}
