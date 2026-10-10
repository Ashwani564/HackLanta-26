import type { Constraints } from "../types.js";
import { allergenConfidence } from "./allergens.js";
import { haversineKm } from "./filter.js";
import type { Pick } from "./explain.js";

const WALK_KM_PER_MIN = 0.08; // ~4.8 km/h

export function appleMapsUrl(lat: number, lng: number): string {
  return `https://maps.apple.com/?daddr=${lat},${lng}&dirflg=w`;
}

const ALLERGY_NOTE = "Allergy note: always confirm ingredients with the restaurant before ordering.";

const hasAllergy = (c: Constraints) => c.allergens.length > 0 || c.unmappedAllergyTerms.length > 0;

export function formatReply(
  picks: readonly Pick[],
  constraints: Constraints,
  opts: { origin?: { lat: number; lng: number }; groupChat?: boolean } = {},
): string {
  if (picks.length === 0) {
    const none = "I couldn't find anything that fits all the restrictions nearby. Want me to loosen the budget or the cuisine?";
    return hasAllergy(constraints) ? `${none}\n${ALLERGY_NOTE}` : none;
  }

  const lines = picks.map(({ dish, reason }, i) => {
    const bits = [`${dish.dishName} at ${dish.restaurantName}`];
    if (dish.priceUsd !== null) bits.push(`$${dish.priceUsd.toFixed(2)}`);
    if (opts.origin) {
      bits.push(`~${Math.max(1, Math.round(haversineKm(opts.origin, dish) / WALK_KM_PER_MIN))} min walk`);
    }
    const unconfirmed = hasAllergy(constraints) && allergenConfidence(dish) === "unconfirmed";
    return [
      `${i + 1}. ${bits.join(" · ")}`,
      `   ${reason}${unconfirmed ? " (allergen info is estimated)" : ""}`,
      `   ${appleMapsUrl(dish.lat, dish.lng)}`,
    ].join("\n");
  });

  const out = [opts.groupChat ? "Works for everyone's restrictions:" : "Here you go:", ...lines];
  if (hasAllergy(constraints)) out.push(ALLERGY_NOTE);
  return out.join("\n");
}
