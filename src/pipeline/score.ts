import type { Candidate } from "../types.js";
import type { Goal } from "./parse.js";
import { haversineKm } from "./filter.js";

/**
 * Tunable in one place. CLAUDE.md specifies goal 0.35 / distance 0.25 / rating 0.20 / price 0.20, but the
 * catalog has no ratings yet, so rating's weight goes to semantic similarity to the request.
 */
export const SCORE_WEIGHTS = { goalFit: 0.3, similarity: 0.3, distance: 0.25, priceFit: 0.15 } as const;

/** Distance beyond which a dish scores 0 for distance (matches the 1.5 km filter radius). */
export const MAX_WALK_KM = 1.5;

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));
const UNKNOWN = 0.3; // missing data scores below neutral, never above

export function goalFit(d: Candidate, goals: readonly Goal[]): number {
  const active = goals.filter((g) => g !== "none");
  if (active.length === 0) return 0.5;
  const scores = active.map((g) => {
    switch (g) {
      case "high_protein":
        return d.proteinG === null ? UNKNOWN : clamp01(d.proteinG / 40);
      case "low_sodium":
        return d.sodiumMg === null ? UNKNOWN : clamp01(1 - d.sodiumMg / 1500);
      case "low_cal":
        return d.calories === null ? UNKNOWN : clamp01(1 - d.calories / 1000);
      default:
        return 0.5;
    }
  });
  // Goals are soft and averaged across people. They never filter.
  return scores.reduce((a, b) => a + b, 0) / scores.length;
}

/**
 * Does the price fit? Over-budget dishes are already filtered out, so everything that reaches here fits
 * and scores the same. "Cheaper is better" would push $4 plain rice above relevant $11 dishes; the
 * "cheaper" follow-up should tighten the budget instead.
 */
export function priceFit(d: Candidate, budgetMaxUsd?: number): number {
  if (d.priceUsd === null) return UNKNOWN;
  if (budgetMaxUsd === undefined) return 0.5;
  return d.priceUsd <= budgetMaxUsd ? 1 : 0;
}

export function distanceScore(d: Candidate, origin?: { lat: number; lng: number }): number {
  if (!origin) return 0.5;
  return clamp01(1 - haversineKm(origin, d) / MAX_WALK_KM);
}

export interface ScoreContext {
  goals: readonly Goal[];
  budgetMaxUsd?: number;
  origin?: { lat: number; lng: number };
}

export function scoreDish(d: Candidate, ctx: ScoreContext): number {
  return (
    SCORE_WEIGHTS.goalFit * goalFit(d, ctx.goals) +
    SCORE_WEIGHTS.similarity * clamp01(d.similarity) +
    SCORE_WEIGHTS.distance * distanceScore(d, ctx.origin) +
    SCORE_WEIGHTS.priceFit * priceFit(d, ctx.budgetMaxUsd)
  );
}

export function rankDishes(candidates: readonly Candidate[], ctx: ScoreContext): Candidate[] {
  return candidates
    .map((c) => ({ c, s: scoreDish(c, ctx) }))
    .sort((a, b) => b.s - a.s || a.c.dishId.localeCompare(b.c.dishId))
    .map(({ c }) => c);
}
