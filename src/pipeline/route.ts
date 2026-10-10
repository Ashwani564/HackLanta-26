import type { ItemKind } from "../types.js";
import type { ParsedMessage } from "./parse.js";

/** Where an incoming message goes. Only "recommend" touches the RAG store. */
export type Route = "recommend" | "update_profile" | "reply_only";

export function routeMessage(parsed: ParsedMessage): Route {
  switch (parsed.intent) {
    case "food_request":
    case "followup":
      return "recommend";
    case "profile_update":
      return "update_profile";
    default:
      return "reply_only";
  }
}

/** Which kinds of item to search. Meals unless the person asked for something else. [] means every kind. */
export function retrievalKinds(parsed: ParsedMessage): ItemKind[] {
  if (parsed.itemKind === "any") return [];
  return [parsed.itemKind ?? "meal"];
}

/**
 * The text to embed. A follow-up like "cheaper" has no food words of its own, so it reuses the previous query.
 * With nothing to go on, fall back to a generic meal query so filters alone still produce results.
 */
export function retrievalQuery(parsed: ParsedMessage, lastQuery?: string): string {
  if (parsed.positiveQuery) return parsed.positiveQuery;
  if (parsed.intent === "followup" && lastQuery) return lastQuery;
  return "a satisfying meal";
}
