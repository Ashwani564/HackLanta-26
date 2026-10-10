// The "what should I eat" flow: nearby restaurants -> two dishes at the one they pick.
// Allergen and diet filtering all happens in the backend code (src/rag, src/pipeline); the model
// only chooses among dishes that already passed, and this file writes the final dish message.
import { allergenConfidence } from "../../src/pipeline/allergens.js";
import { haversineKm } from "../../src/pipeline/filter.js";
import { pickDishes, type Pick } from "../../src/pipeline/explain.js";
import { appleMapsUrl } from "../../src/pipeline/format.js";
import { buildConstraints, parseMessage, type ParsedMessage } from "../../src/pipeline/parse.js";
import { rankDishes } from "../../src/pipeline/score.js";
import { retrieve } from "../../src/rag/retrieve.js";
import { listRestaurants, type RestaurantSummary } from "../../src/rag/store.js";
import type { Constraints } from "../../src/types.js";
import type { PollSpec } from "./polls.js";
import { getState, putState } from "./store.js";

export type Origin = { lat: number; lng: number };
const WALK_KM_PER_MIN = 0.08; // ~4.8 km/h, same as the backend's walking estimate
/** The catalog only covers the GSU area. Beyond this we say so instead of pretending. */
const NEARBY_KM = 2.5;

const pick = <T>(xs: readonly T[]): T => xs[Math.floor(Math.random() * xs.length)]!;

/** How a person says the restaurant's name out loud. Falls back to the catalog name. */
const SAY: Record<string, string> = {
  "india-eats": "India Eats",
  mangos: "Mango's",
  moes: "Moe's",
  "mr-fries-man": "Mr. Fries Man",
  "queen-tea": "Queen Tea",
  saxbys: "Saxby's",
  starbucks: "Starbucks",
  "stir-house": "Stir House",
  "strikeout-wingz": "StrikeOut Wingz",
};
const sayName = (id: string, full: string) => SAY[id] ?? full;

// ---------- restrictions that only ever accumulate ----------

export interface Restrictions {
  allergies: string[];
  diets: string[];
}

const profileKey = (spaceId: string) => `profile#${spaceId}`;
const norm = (xs: unknown): string[] =>
  Array.isArray(xs) ? xs.filter((x): x is string => typeof x === "string").map((x) => x.trim().toLowerCase()).filter(Boolean) : [];

/**
 * Merge what the model just passed with everything this chat has ever said. An allergy mentioned ten
 * messages ago must still apply, even after the chat history has scrolled past it.
 */
export async function mergeRestrictions(spaceId: string, args: { allergies?: unknown; diets?: unknown }): Promise<Restrictions> {
  const stored = (await getState<Restrictions>(profileKey(spaceId))) ?? { allergies: [], diets: [] };
  const merged = {
    allergies: [...new Set([...stored.allergies, ...norm(args.allergies)])].sort(),
    diets: [...new Set([...stored.diets, ...norm(args.diets)])].sort(),
  };
  if (merged.allergies.length !== stored.allergies.length || merged.diets.length !== stored.diets.length) {
    await putState(profileKey(spaceId), merged, 7 * 86400);
  }
  return merged;
}

export const clearRestrictions = (spaceId: string) => putState(profileKey(spaceId), { allergies: [], diets: [] }, 7 * 86400);

const EMPTY_PARSE: ParsedMessage = { intent: "food_request", positiveQuery: "", allergies: [], diets: [], exclude: [] };

export const constraintsFor = (r: Restrictions, budgetMaxUsd?: number): Constraints =>
  buildConstraints({ allergies: r.allergies, diets: r.diets, ...(budgetMaxUsd && budgetMaxUsd > 0 && { budgetMaxUsd }) }, EMPTY_PARSE);

const hasAllergy = (c: Constraints) => c.allergens.length > 0 || c.unmappedAllergyTerms.length > 0;

// ---------- nearby restaurants ----------

interface NearbyEntry {
  id: string;
  name: string; // as people say it
  fullName: string;
  walkMin: number;
  km: number;
}

interface Destination {
  name: string;
  lat: number;
  lng: number;
}

const nearKey = (spaceId: string) => `near#${spaceId}`;
/** Spots we name and poll. Three is enough to choose from without turning it into a list to read. */
const MAX_SPOTS = 3;

/**
 * Nearest-first, but don't offer two of the same kind of place (Saxby's and Starbucks) while a different
 * one is close by. Falls back to plain nearest if there isn't enough variety.
 */
export function pickVaried<T extends { r: { cuisine: string[] }; km: number }>(nearestFirst: T[], n: number): T[] {
  const chosen: T[] = [];
  const kinds = new Set<string>();
  for (const x of nearestFirst) {
    if (chosen.length === n) break;
    const kind = x.r.cuisine[0] ?? "";
    if (kind && kinds.has(kind)) continue;
    kinds.add(kind);
    chosen.push(x);
  }
  for (const x of nearestFirst) {
    if (chosen.length === n) break;
    if (!chosen.includes(x)) chosen.push(x);
  }
  return chosen.sort((a, b) => a.km - b.km);
}
const priceRange = (r: RestaurantSummary) =>
  r.minPriceUsd === null || r.maxPriceUsd === null ? undefined : `$${Math.round(r.minPriceUsd)}-${Math.round(r.maxPriceUsd)}`;

export async function nearbyRestaurants(spaceId: string, origin: Origin, constraints: Constraints) {
  const rows = await listRestaurants(constraints, ["meal"]);
  const ranked = rows
    .map((r) => ({ r, km: haversineKm(origin, r) }))
    .sort((a, b) => a.km - b.km)
    .map(({ r, km }) => ({ r, km, walkMin: Math.max(1, Math.round(km / WALK_KM_PER_MIN)) }));

  const close = pickVaried(ranked.filter((x) => x.km <= NEARBY_KM), MAX_SPOTS);
  const shown = close.length > 0 ? close : ranked.slice(0, 2);
  const farAway = close.length === 0 && shown.length > 0;

  await putState(
    nearKey(spaceId),
    shown.map(({ r, km, walkMin }): NearbyEntry => ({ id: r.restaurantId, name: sayName(r.restaurantId, r.restaurantName), fullName: r.restaurantName, km, walkMin })),
    3 * 3600,
  );
  return {
    restaurants: shown.map(({ r, km, walkMin }) => ({
      name: sayName(r.restaurantId, r.restaurantName),
      walk_minutes: walkMin,
      miles_away: +(km * 0.621371).toFixed(1),
      cuisine: r.cuisine,
      typical_meal_price: priceRange(r),
    })),
    // Nothing within walking range of where they actually are. The model must say that plainly.
    far_away: farAway,
    none_match_restrictions: rows.length === 0,
  };
}

/** What people call the nine restaurants (squashed: no spaces or punctuation) -> the name we use. */
const RESTAURANT_ALIASES: Record<string, string> = {
  moes: "Moe's", mangos: "Mango's", queentea: "Queen Tea", saxbys: "Saxby's", starbucks: "Starbucks", stirhouse: "Stir House",
  strikeoutwingz: "StrikeOut Wingz", strikeoutwings: "StrikeOut Wingz", indiaeats: "India Eats", mrfriesman: "Mr. Fries Man",
};
/** The restaurant a message names, if any. Read from what the person typed, not from what the model passes along. */
export const restaurantNamed = (text: string): string | undefined => {
  const t = text.toLowerCase().replace(/[^a-z0-9]+/g, "");
  const hit = Object.keys(RESTAURANT_ALIASES).find((a) => t.includes(a));
  return hit ? RESTAURANT_ALIASES[hit] : undefined;
};
export const namesRestaurant = (text: string) => restaurantNamed(text) !== undefined;

// ---------- two dishes at the restaurant they chose ----------

const squash = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, "");

/** Match what the person said ("moes", "the wing place") against restaurants we offered or all that fit. */
async function resolveRestaurant(spaceId: string, said: string, constraints: Constraints) {
  const want = squash(said);
  if (!want) return undefined;
  const offered = (await getState<NearbyEntry[]>(nearKey(spaceId))) ?? [];
  const hit = (...names: string[]) => names.some((n) => squash(n).includes(want) || want.includes(squash(n)));
  const fromOffered = offered.find((o) => hit(o.name, o.fullName));
  if (fromOffered) return { id: fromOffered.id, name: fromOffered.name };
  // Not one we listed (they may have named a place that was further down): any restaurant with food they can eat.
  const all = await listRestaurants(constraints, ["meal"]);
  const found = all.find((r) => hit(sayName(r.restaurantId, r.restaurantName), r.restaurantName));
  return found ? { id: found.restaurantId, name: sayName(found.restaurantId, found.restaurantName) } : undefined;
}

/** Always shown. Many menu items have no price in the data; say so instead of leaving it blank or guessing. */
export const price = (p: number | null) => (p === null ? " (no price listed)" : ` ($${Number.isInteger(p) ? p : p.toFixed(2)})`);

/** Menus are missing prices for about half the dishes. When at least `n` priced dishes exist, pick from those. */
export function preferPriced<T extends { priceUsd: number | null }>(ranked: readonly T[], n = 2): T[] {
  const priced = ranked.filter((d) => d.priceUsd !== null);
  return priced.length >= n ? priced : [...ranked];
}
const trimReason = (r: string) => r.trim().replace(/[.!\s]+$/, "");

/** Menu names shout and carry noise ("CHICKEN TIKKA MASALLA - SERVED WITH RICE"). Say it like a person would. */
export function tidyName(name: string): string {
  let n = name.replace(/\s*[-–—]\s*served with.*$/i, "").replace(/\s+/g, " ").trim();
  if (n === n.toUpperCase()) n = n.toLowerCase();
  return n;
}

/**
 * The reason the picker wrote, or, when it fell back to its generic "A solid pick at ..." line, plain facts
 * from the data. Never invents anything.
 */
function reasonFor(p: Pick): string {
  const generic = `A solid pick at ${p.dish.restaurantName}.`;
  if (p.reason && p.reason !== generic) return trimReason(p.reason);
  const bits: string[] = [];
  if (p.dish.proteinG !== null) bits.push(`${Math.round(p.dish.proteinG)}g protein`);
  if (p.dish.calories !== null) bits.push(`about ${Math.round(p.dish.calories)} cal`);
  return bits.join(", ");
}

/** Casual two-dish message. Allergy wording is added here, in code, never by the model. */
export function composeDishMessage(restaurantName: string, picks: readonly Pick[], constraints: Constraints): string {
  // If at least one pick has a price, every pick shows its price (or "no price listed"). If none do,
  // say so once instead of repeating it on every line.
  const anyPrice = picks.some((p) => p.dish.priceUsd !== null);
  const label = (p: Pick) => `${p.name ?? tidyName(p.dish.dishName)}${anyPrice ? price(p.dish.priceUsd) : ""}`;
  const withReason = (lead: string, p: Pick, joiner: string) => {
    const r = reasonFor(p);
    return r ? `${lead}${joiner}${r}` : lead;
  };
  const [a, b] = picks;
  if (!a) return "";
  const lines = [
    pick([
      withReason(`at ${restaurantName} i'd go with the ${label(a)}`, a, ", "),
      withReason(`get the ${label(a)} at ${restaurantName}`, a, ". "),
      withReason(`${restaurantName}: the ${label(a)} for sure`, a, ", "),
    ]),
  ];
  if (b) {
    lines.push(
      pick([
        withReason(`or the ${label(b)} if you want something different`, b, ", "),
        withReason(`${label(b)} is good too`, b, ", "),
        withReason(`if not that, the ${label(b)}`, b, ". "),
      ]),
    );
  }
  if (!anyPrice) lines.push(pick(["they don't list prices here", "no prices on their menu though", "their menu doesn't list prices"]));
  if (hasAllergy(constraints)) {
    const estimated = picks.some((p) => allergenConfidence(p.dish) === "unconfirmed");
    lines.push(
      estimated
        ? "the allergen info on these is an estimate, so double check with them before you order"
        : "double check with them before you order tho, since you've got the allergy",
    );
  }
  return lines.join("\n\n");
}

const destKey = (spaceId: string) => `dest#${spaceId}`;
const dishesKey = (spaceId: string) => `dishes#${spaceId}`;

export interface DishChoice {
  label: string;
  name: string;
  calories: number | null;
  proteinG: number | null;
}

/** The Apple Maps walking link for the last restaurant we picked dishes at. Only call after they say yes. */
export async function directionsLink(spaceId: string): Promise<{ url?: string; name?: string; error?: string }> {
  const dest = await getState<Destination>(destKey(spaceId));
  if (!dest) return { error: "no restaurant picked yet" };
  return { url: appleMapsUrl(dest.lat, dest.lng), name: dest.name };
}

export async function restaurantDishes(
  spaceId: string,
  args: { restaurant: string; request?: string },
  constraints: Constraints,
  origin?: Origin,
): Promise<{ text?: string; choices?: DishChoice[]; restaurant?: string; error?: string; options?: string[] }> {
  const place = await resolveRestaurant(spaceId, args.restaurant, constraints);
  if (!place) {
    const offered = (await getState<NearbyEntry[]>(nearKey(spaceId))) ?? [];
    return { error: `couldn't match "${args.restaurant}" to a restaurant`, options: offered.map((o) => o.name) };
  }

  const request = (args.request ?? "").trim();
  const parsed = request ? await parseMessage(request) : EMPTY_PARSE;
  const query = parsed.positiveQuery || request || "popular main dish";
  let { candidates } = await retrieve(query, constraints, { kinds: ["meal"], restaurantId: place.id, limit: 25 });
  if (candidates.length === 0) ({ candidates } = await retrieve(query, constraints, { restaurantId: place.id, limit: 25 }));
  if (candidates.length === 0) return { error: `nothing at ${place.name} matches those restrictions` };

  const ranked = rankDishes(candidates, {
    goals: parsed.goal ? [parsed.goal] : [],
    ...(constraints.budgetMaxUsd !== undefined && { budgetMaxUsd: constraints.budgetMaxUsd }),
    ...(origin && { origin }),
  });
  const picks = await pickDishes(request || "what's best on the menu", preferPriced(ranked), 2, { casual: true });
  const first = ranked[0]!;
  // Remember where this is so "yeah" to "want directions?" can send the link, and nothing is sent before that.
  await putState(destKey(spaceId), { name: place.name, lat: first.lat, lng: first.lng } satisfies Destination, 3 * 3600);
  const anyPrice = picks.some((p) => p.dish.priceUsd !== null);
  const choices = picks.map((p): DishChoice => ({
    label: `${p.name ?? tidyName(p.dish.dishName)}${anyPrice ? price(p.dish.priceUsd) : ""}`,
    name: p.name ?? tidyName(p.dish.dishName),
    calories: p.dish.calories,
    proteinG: p.dish.proteinG,
  }));
  await putState(dishesKey(spaceId), { restaurant: place.name, choices }, 3 * 3600);
  return { text: composeDishMessage(place.name, picks, constraints), choices, restaurant: place.name };
}

// ---------- the choices, as polls ----------
// Each step returns the next poll to send (or nothing). Typed answers and poll votes both go through here.

type Near = Awaited<ReturnType<typeof nearbyRestaurants>>;

/** The text that names the spots. Built from the same list as the poll, so the two always match. */
export function spotsText(spots: Near["restaurants"]): string {
  const [a, b, c] = spots;
  if (!a || !b) return "";
  const min = (r: { walk_minutes: number }) => `${r.walk_minutes} min`;
  if (!c) return `${a.name} is ${min(a)} away, ${b.name} is ${min(b)}`;
  return pick([
    `${a.name} is a ${min(a)} walk, ${b.name} is ${min(b)}, and ${c.name} is ${min(c)}`,
    `closest are ${a.name} (${min(a)}), ${b.name} (${min(b)}) and ${c.name} (${min(c)})`,
    `${a.name} is ${min(a)} away, ${b.name} ${min(b)}, ${c.name} ${min(c)}`,
  ]);
}

export function restaurantPoll(near: Near): PollSpec | undefined {
  if (near.far_away || near.restaurants.length < 2) return undefined;
  const spots = near.restaurants.slice(0, MAX_SPOTS);
  return {
    kind: "restaurant",
    intro: spotsText(spots),
    title: "pick a spot",
    options: spots.map((r) => ({ label: `${r.name} · ${r.walk_minutes} min`, value: r.name })),
  };
}

export function dishPoll(restaurant: string, choices: readonly DishChoice[]): PollSpec | undefined {
  if (choices.length < 2) return undefined;
  return { kind: "dish", title: `what are you getting at ${restaurant}?`, options: choices.map((c) => ({ label: c.label, value: c.name })) };
}

/** Asked in plain text after they pick a dish (no poll). The map link is only sent if they say yes. */
export const askDirections = () => pick(["want directions?", "need directions over there?", "want me to send the walk there?"]);

/** They chose a dish: a short reaction with the numbers if we have them, then a plain-text offer of directions. */
export async function chooseDish(spaceId: string, said: string): Promise<{ text?: string; error?: string }> {
  const saved = await getState<{ restaurant: string; choices: DishChoice[] }>(dishesKey(spaceId));
  if (!saved) return { error: "no dishes offered yet" };
  const want = squash(said);
  const dish = saved.choices.find((c) => squash(c.name) === want || squash(c.label) === want) ?? saved.choices.find((c) => squash(c.label).includes(want) || want.includes(squash(c.name)));
  if (!dish) return { error: `couldn't match "${said}"`, text: undefined };
  const facts = [dish.calories !== null && `about ${Math.round(dish.calories)} cal`, dish.proteinG !== null && `${Math.round(dish.proteinG)}g protein`].filter(Boolean).join(", ");
  const text = pick(
    facts
      ? [`nice, the ${dish.name} runs ${facts}`, `good call, ${facts} on the ${dish.name}`, `the ${dish.name}, solid. ${facts}`]
      : [`nice pick, the ${dish.name}`, `good call on the ${dish.name}`, `the ${dish.name}, solid`],
  );
  return { text: `${text}\n\n${askDirections()}` };
}
