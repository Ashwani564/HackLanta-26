// "Wanna grab lunch with Ash and Princy": the bot texts each person separately, settles a time and a place,
// then tells the organizer.
//
//   ask_time the organizer is asked what time they're thinking (skipped if they already said, or said "anytime")
//   time     each person gets a poll of times around that (tap every one that works) AND a poll of every place
//            that fits ALL their food restrictions, sent together. The bot waits until they stop tapping.
//            Someone who can only pick "can't make it" gets a sorry, is asked what other time they could do, and
//            the rest are asked whether they could move.
//   confirm  anyone not free at the time that fits the most people is asked "does 7:00 work?" (a no drops them)
//   place    most votes among the places wins (re-checked against everyone's current restrictions)
//   done     everyone gets the details and a card, and so does the organizer
//
// Shared context: the plan's typed-reply routing and the "what's the plan?" note given to the chat model live for
// PLAN_CONTEXT_MIN (5) minutes from the request. After that, typed messages are ordinary chat and stop being
// treated as plan answers; poll taps are still read.
//
// Anyone who has answered while others haven't is told to hang tight, once per question.
//
// People answer whenever they like, so a plan can't live inside one running function. Its state is saved, and
// `advance` is called from (a) a check every minute, (b) the person who asked, for the first few minutes, and
// (c) a typed reply. `advance` is safe to call any number of times; a short lease keeps two callers apart.
import { converseTool } from "../../src/llm/bedrock.js";
import { haversineKm } from "../../src/pipeline/filter.js";
import { listRestaurants } from "../../src/rag/store.js";
import { type Origin, type Restrictions, constraintsFor, restrictionsFor, unionRestrictions } from "./dining.js";
import { peekLocation, requestLocation } from "./findmy.js";
import { type MeetupCard, meetupJpeg } from "./meetup-card.js";
import { type PollRecord, type PollSpec, readVotes, realPolls } from "./polls.js";
import { getState, leaseOnce, putState, releaseLease } from "./store.js";
import { TIME_ZONE } from "./day.js";
import { getUser, listProfiles } from "./users.js";
import { publishCard } from "./cards.js";
import { servesMeal } from "../../src/data/cuisines.js";

export type Meal = "dinner" | "lunch" | "breakfast";
export type Day = "today" | "tomorrow";
type Stage = "ask_time" | "time" | "confirm" | "place" | "done" | "failed";
type AskKey = "time" | "confirm" | "place" | "alt";

interface Ask {
  rec: PollRecord;
  sentAt: number;
  nudged?: boolean;
  /** Set once the answer is final (the person stopped tapping, or it's a single-choice question). */
  answer?: string;
  /** Everything they picked, for polls that allow several. */
  picks?: string[];
  /** What's ticked right now and since when: a multi-pick poll is final once this stops changing. */
  sig?: string;
  changedAt?: number;
}
interface Person {
  name: string;
  phone: string;
  chatGuid: string;
  time?: Ask;
  confirm?: Ask;
  place?: Ask;
  /** "What other time could you do?", asked once to someone who couldn't make any of the first times. */
  alt?: Ask;
  altTried?: boolean;
  /** Asked to confirm a moved time, but not yet sent (one message at a time). */
  needsConfirm?: boolean;
  /** When we asked for their location (the step before the place poll). */
  locAskedAt?: number;
  /** Why they're no longer in the plan. */
  out?: string;
  /** Where they are (Find My), when they shared it. */
  loc?: Origin;
  locAsked?: boolean;
  /** Questions after which they've already been told to hang tight. */
  held?: Record<string, boolean>;
}
export interface Plan {
  id: string;
  createdAt: number;
  meal: Meal;
  day: Day;
  /** The organizer is a participant too: they vote on places and confirm a moved time. */
  organizer: Person;
  people: Person[];
  /** Time options as "HH:MM", in order. */
  slots: string[];
  /** The time the organizer asked for ("19:00"). Unset when they said anytime. */
  anchor?: string;
  /** Extra times offered to someone who couldn't make the first ones. */
  altSlots?: string[];
  /** Typed replies count as plan answers until this (the shared context window). */
  contextUntil: number;
  /** Who couldn't make the first times, for the "could you move?" wording. */
  movedFor?: string[];
  stage: Stage;
  proposed?: string;
  timeChoice?: string;
  places?: Place[];
  /** How many places exist at all, so we can say "4 of 9 work for everyone". */
  placesTotal?: number;
  placeChoice?: string;
  /** Don't wait past this for people's locations. */
  locWaitUntil?: number;
}
export interface Place {
  name: string;
  lat?: number;
  lng?: number;
  /** The longest walk anyone in the group has to it. */
  walkMin?: number;
}

export interface PlanDeps {
  now(): number;
  /** Text one person (opening the chat if needed). Returns the chat's GUID. */
  sendText(phone: string, text: string): Promise<string>;
  /** Make sure there's a chat with this person (polls need one) without sending anything. Returns its GUID. */
  openChat(phone: string): Promise<string>;
  /** `read` returns every option currently ticked (empty if none). */
  polls: { send(chatGuid: string, spec: PollSpec): Promise<PollRecord>; read(rec: PollRecord): Promise<string[]> };
  /** Find My: a quiet look at where someone is, and the share-request card (never waits for the tap). */
  location: { peek(phone: string): Promise<Origin | undefined>; request(chatGuid: string, phone: string): Promise<void> };
  /** The "it's on" card, sent to one person as a picture. */
  sendCard(phone: string, card: MeetupCard): Promise<void>;
  users(): Promise<{ firstName: string | null; lastName: string | null; phoneNumber: string }[]>;
  /** Up to three places that work for all of these restrictions, the fairest walk for everyone first. */
  places(restrictions: Restrictions, origins: Origin[], meal: Meal): Promise<Place[]>;
  organizerOrigin(chatGuid: string): Promise<Origin | undefined>;
  /** Which option (index) a typed reply means, or -1 if it isn't an answer. */
  interpret(question: string, options: string[], text: string): Promise<number>;
  restrictionsFor(chatGuid: string): Promise<Restrictions>;
}

const minutes = (m: number) => m * 60_000;
/** How long typed replies and the "what's the plan?" note stay tied to a plan, counted from the request. */
const CONTEXT_MS = () => minutes(Number(process.env.PLAN_CONTEXT_MIN ?? 5));
/** Reminders are off by default: after one message to someone we wait quietly for their reply. */
const NUDGE_MS = () => minutes(Number(process.env.PLAN_NUDGE_MIN ?? 0));
/** After asking for someone's location, how long to wait for them to share before the place poll goes out anyway. */
const LOC_STEP_MS = () => Number(process.env.PLAN_LOC_STEP_SEC ?? 45) * 1000;
const GIVE_UP_MS = () => minutes(Number(process.env.PLAN_GIVE_UP_MIN ?? 5));
/** No plan stays active longer than this, whatever it is waiting on. A plan that can never finish would otherwise keep the every-minute check busy for days. */
const MAX_PLAN_MS = () => minutes(Number(process.env.PLAN_MAX_MIN ?? 180));
/** A multi-pick poll counts once nothing has changed for this long. */
const SETTLE_MS = () => Number(process.env.PLAN_SETTLE_SEC ?? 3) * 1000;
/** How long the place step waits for people who haven't shared their location. */
const LOC_WAIT_MS = () => minutes(Number(process.env.PLAN_LOC_WAIT_MIN ?? 3));
const WALK_KM_PER_MIN = 0.08;
const walkMinutes = (a: Origin, b: { lat?: number; lng?: number }) =>
  b.lat === undefined || b.lng === undefined ? undefined : Math.max(1, Math.round(haversineKm(a, { lat: b.lat, lng: b.lng }) / WALK_KM_PER_MIN));
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(Math.random() * xs.length)]!;
const cap = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : s);

// ---------- times ----------

const WINDOWS: Record<Meal, [string, string]> = { dinner: ["17:30", "20:30"], lunch: ["11:30", "14:00"], breakfast: ["07:30", "10:00"] };
const toMin = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));
const toHHMM = (min: number) => `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;

export function label(hhmm: string): string {
  const h = Number(hhmm.slice(0, 2)), m = hhmm.slice(3);
  return `${h % 12 || 12}:${m} ${h >= 12 ? "PM" : "AM"}`;
}

/** Minutes since midnight right now in the bot's time zone. */
export function minutesNow(ms: number, tz = TIME_ZONE): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "numeric", hour12: false }).formatToParts(new Date(ms));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  return (get("hour") % 24) * 60 + get("minute");
}

/** Half-hour options for the meal. For today, only times still ahead (with 30 minutes' notice). */
export function slotsFor(meal: Meal, day: Day, nowMs: number, opts: { earliestHour?: number; latestHour?: number } = {}): string[] {
  const [start, end] = WINDOWS[meal];
  const floor = day === "today" ? minutesNow(nowMs) + 30 : 0;
  const slots: string[] = [];
  for (let m = toMin(start); m <= toMin(end); m += 30) {
    if (m < floor) continue;
    if (opts.earliestHour !== undefined && m < opts.earliestHour * 60) continue;
    if (opts.latestHour !== undefined && m > opts.latestHour * 60) continue;
    slots.push(toHHMM(m));
  }
  return slots;
}

/** The lower median of everyone's pick: the time that asks the fewest people to move the least. */
export function proposeTime(pickIdx: number[]): { index: number; unanimous: boolean } {
  const sorted = [...pickIdx].sort((a, b) => a - b);
  const index = sorted[Math.floor((sorted.length - 1) / 2)]!;
  return { index, unanimous: sorted.every((i) => i === index) };
}

/**
 * People tick every time that works for them. The best time is the one the most people can do; among equals, the
 * one closest to the middle of everything picked. `everyone` says whether it works for all of them.
 */
export function chooseTime(slots: readonly string[], picksByPerson: readonly (readonly string[])[]): { index: number; everyone: boolean } {
  const all = picksByPerson.flatMap((p) => p.map((v) => slots.indexOf(v))).filter((i) => i >= 0).sort((a, b) => a - b);
  const middle = all.length > 0 ? all[Math.floor((all.length - 1) / 2)]! : 0;
  let best = -1, bestCount = -1, bestGap = Infinity;
  slots.forEach((slot, i) => {
    const count = picksByPerson.filter((p) => p.includes(slot)).length;
    const gap = Math.abs(i - middle);
    if (count > bestCount || (count === bestCount && gap < bestGap)) (best = i), (bestCount = count), (bestGap = gap);
  });
  return { index: Math.max(best, 0), everyone: bestCount === picksByPerson.length };
}

/** Most votes wins; a tie goes to the option listed first (the nearest). */
export function winner(options: readonly string[], votes: readonly string[]): string | undefined {
  let best: string | undefined, bestCount = 0;
  for (const o of options) {
    const count = votes.filter((v) => v === o).length;
    if (count > bestCount) (best = o), (bestCount = count);
  }
  return best;
}

// ---------- storage ----------

const planKey = (id: string) => `plan#${id}`;
const pointerKey = (phone: string) => `planfor#${phone}`;
const lockKey = (id: string) => `planlock#${id}`;
/** Points a person at their live plan for as long as it runs (the typed-reply pointer above expires after 5 minutes). */
const voteKey = (phone: string) => `planvote#${phone}`;
const ACTIVE = "plans#active";
const PLAN_TTL = 3 * 86400;
/** The per-person pointer that routes a typed reply to its plan. It expires with the context window. */
const pointerTtl = () => Math.ceil(CONTEXT_MS() / 1000);
const contextOpen = (plan: Plan, nowMs: number) => nowMs < plan.contextUntil;

const getPlan = (id: string) => getState<Plan>(planKey(id));
const savePlan = (plan: Plan) => putState(planKey(plan.id), plan, PLAN_TTL);
const activeIds = async () => (await getState<string[]>(ACTIVE)) ?? [];
const setActive = (ids: string[]) => putState(ACTIVE, ids, PLAN_TTL);

async function withLease<T>(id: string, fn: () => Promise<T>, waitMs = 0): Promise<T | undefined> {
  const deadline = Date.now() + waitMs;
  while (!(await leaseOnce(lockKey(id), 90))) {
    if (Date.now() >= deadline) return undefined;
    await new Promise((r) => setTimeout(r, 500));
  }
  try {
    return await fn();
  } finally {
    await releaseLease(lockKey(id));
  }
}

// ---------- the engine ----------

const live = (plan: Plan) => plan.people.filter((p) => !p.out);
/** Everyone who gets asked things: the organizer and the people still in. */
const askers = (plan: Plan): Person[] => [plan.organizer, ...live(plan)];
/** Reads the stage fresh each time (the stage functions change it, which TypeScript can't see through). */
const stageOf = (plan: Plan): Stage => plan.stage;
const isOver = (plan: Plan) => stageOf(plan) === "done" || stageOf(plan) === "failed";
const names = (ps: readonly { name: string }[]) => {
  const n = ps.map((p) => cap(p.name));
  return n.length <= 1 ? (n[0] ?? "") : `${n.slice(0, -1).join(", ")} and ${n[n.length - 1]}`;
};

/**
 * One message: the poll itself (its title says who is asking and what). If Photon can't create the poll, the question and
 * its options go as one text instead, and typed replies are read like taps.
 */
async function ask(plan: Plan, p: Person, d: PlanDeps, spec: PollSpec): Promise<Ask> {
  p.chatGuid ||= await d.openChat(p.phone);
  try {
    return { rec: await d.polls.send(p.chatGuid, spec), sentAt: d.now() };
  } catch (err) {
    console.warn(`  plan ${plan.id}: poll for ${p.name} failed (${(err as Error).message}); asking in a text instead`);
    p.chatGuid = await d.sendText(p.phone, `${spec.title}\n${spec.options.map((o) => o.label).join("\n")}`);
    return { rec: { ...spec, guid: `text-${plan.id}-${p.phone}-${d.now()}`, chatGuid: p.chatGuid, optionIds: {} }, sentAt: d.now() };
  }
}

const picksOf = (a?: Ask): string[] => a?.picks ?? (a?.answer ? [a.answer] : []);

/** A short "got it" naming what they ticked ("got it, 8:30 PM or 9:00 PM"). Nothing for declines or yes/no answers. */
function ackFor(key: AskKey, a: Ask): string | undefined {
  if (key === "confirm") return undefined;
  const picked = picksOf(a);
  if (picked.length === 0 || picked.some((v) => v === "no" || v === "none")) return undefined;
  const names = picked.map((v) => (a.rec.options.find((o) => o.value === v)?.label ?? v).replace(/ · \d+ min$/, ""));
  const said = names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} or ${names[names.length - 1]}`;
  return pick([`got it, ${said}`, `${said}, noted`, `bet, ${said} for you`, `${said}, locked in`]);
}

async function readAnswers(plan: Plan, d: PlanDeps) {
  for (const p of askers(plan)) {
    for (const key of ["time", "confirm", "place", "alt"] as const) {
      const a = p[key];
      if (!a || a.answer || a.rec.guid.startsWith("text-")) continue;
      try {
        const votes = await d.polls.read(a.rec);
        if (votes.length === 0) {
          a.sig = undefined;
          continue;
        }
        if (!a.rec.multi) {
          a.answer = votes[0]!;
          const ack = ackFor(key, a);
          if (ack) await d.sendText(p.phone, ack);
          continue;
        }
        // Several taps allowed: wait until they stop changing their mind, and say nothing in between.
        const sig = votes.join("|");
        if (sig !== a.sig) {
          a.sig = sig;
          a.changedAt = d.now();
        } else if (d.now() - (a.changedAt ?? d.now()) >= SETTLE_MS()) {
          a.picks = votes;
          a.answer = votes[0]!;
          const ack = ackFor(key, a);
          if (ack) await d.sendText(p.phone, ack);
        }
      } catch (err) {
        console.warn(`  plan ${plan.id}: couldn't read ${p.name}'s ${key} poll: ${(err as Error).message}`);
      }
    }
  }
}

/** Nudge people who haven't answered; give up on people who still haven't. */
async function chase(plan: Plan, d: PlanDeps, key: AskKey) {
  const now = d.now();
  for (const p of askers(plan)) {
    const a = p[key];
    if (!a || a.answer) continue;
    if (now - a.sentAt > GIVE_UP_MS()) {
      if (p === plan.organizer) {
        // The organizer going quiet shouldn't sink the plan: their vote is just left out.
        a.answer = "no-answer";
        a.picks = [];
      } else {
        p.out = "didn't answer";
        console.log(`  plan ${plan.id}: ${p.name} timed out on ${key}`);
      }
    } else if (NUDGE_MS() > 0 && !a.nudged && now - a.sentAt > NUDGE_MS()) {
      a.nudged = true;
      await d.sendText(p.phone, pick(["still need your pick on that poll 👆", "when you get a sec, tap one on the poll above", "no rush, just need your pick on the poll", "bro tap one on the poll above when you can"]));
    }
  }
}

const waiting = (plan: Plan, key: AskKey) => askers(plan).filter((p) => p[key] && !p[key]!.answer);

async function fail(plan: Plan, d: PlanDeps, why: string) {
  plan.stage = "failed";
  await d.sendText(plan.organizer.phone, `couldn't get ${plan.meal} sorted: ${why}`);
  await finish(plan);
}

async function finish(plan: Plan) {
  for (const p of [plan.organizer, ...plan.people]) {
    await putState(pointerKey(p.phone), null, 1);
    await putState(voteKey(p.phone), null, 1);
  }
  await setActive((await activeIds()).filter((x) => x !== plan.id));
}

/** Someone has answered but others haven't: tell them once to hang tight, instead of leaving them wondering. */
async function hold(plan: Plan, d: PlanDeps, key: AskKey) {
  if (waiting(plan, key).length === 0) return;
  for (const p of askers(plan)) {
    if (!p[key]?.answer || p.held?.[key] || p[key]!.answer === "no-answer" || stillMoving(plan, p)) continue;
    (p.held ??= {})[key] = true;
    await d.sendText(p.phone, pick(["got it, hang tight while i check with the others", "nice, hang tight while i check with everyone else", "ok got it. hang tight, checking with the others", "bet, hang tight gang, still waiting on the others"]));
  }
}

/** Ask for their location once, unless they're already sharing it. */
async function askLocation(d: PlanDeps, who: { phone: string; chatGuid: string; loc?: Origin; locAsked?: boolean }) {
  if (who.locAsked) return;
  who.locAsked = true;
  const have = await d.location.peek(who.phone);
  if (have) {
    who.loc = have;
    return;
  }
  await d.sendText(who.phone, pick(["also, share your location with me so i can find a spot that's close for everyone", "one more thing: tap share on this so i can find a place that's fair for everybody"]));
  await d.location.request(who.chatGuid, who.phone).catch((err) => console.warn(`  couldn't send a location request: ${(err as Error).message}`));
}

// ---------- time ----------

/** Times a person can still do: what they ticked, plus anything they offered after saying the first ones don't work. */
const timesOf = (p: Person) => [...picksOf(p.time), ...picksOf(p.alt)].filter((v) => v !== "no" && v !== "none");

/** Half-hour times just outside the first options, for someone who couldn't make any of them. */
export function altSlotsFor(plan: Pick<Plan, "meal" | "day" | "slots">, nowMs: number): string[] {
  const [start, end] = WINDOWS[plan.meal];
  const floor = plan.day === "today" ? minutesNow(nowMs) + 30 : 0;
  const lo = Math.max(6 * 60, toMin(start) - 150), hi = Math.min(22 * 60 + 30, toMin(end) + 150);
  const out: string[] = [];
  for (let m = Math.ceil(lo / 30) * 30; m <= hi; m += 30) if (m >= floor && !plan.slots.includes(toHHMM(m))) out.push(toHHMM(m));
  return out;
}

/** The first options for a time the organizer gave: a little before and a good stretch after, and the time itself. */
export function slotsAround(anchor: string, day: Day, nowMs: number): string[] {
  const a = toMin(anchor);
  const floor = Math.max(6 * 60, day === "today" ? minutesNow(nowMs) + 30 : 0);
  const mins = new Set<number>([a]);
  for (let m = Math.ceil((a - 60) / 30) * 30; m <= a + 90; m += 30) mins.add(m);
  return [...mins].filter((m) => m >= floor && m <= 22 * 60).sort((x, y) => x - y).map(toHHMM);
}

/** "7", "7:30pm", "around noon", "anytime". A bare hour is read as the meal's usual time (dinner 7 = 7 PM). */
export function parseTimeAnswer(text: string, meal: Meal): { anytime: true } | { hhmm: string } | undefined {
  const t = text.toLowerCase();
  if (/\b(any ?time|whenever|flexible|doesn'?t matter|no preference|up to you|you pick)\b/.test(t)) return { anytime: true };
  if (/\bnoon\b/.test(t)) return { hhmm: "12:00" };
  const m = /\b(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?(?![\d:])/.exec(t);
  if (!m) return undefined;
  let h = Number(m[1]);
  const min = m[2] ? Number(m[2]) : 0;
  const suffix = m[3]?.[0];
  if (min > 59 || h > 23 || (suffix && h > 12)) return undefined;
  if (suffix === "p") h = h === 12 ? 12 : h + 12;
  else if (suffix === "a") h = h === 12 ? 0 : h;
  else if (h < 12) {
    if (meal === "dinner" && h >= 1) h += 12;
    else if (meal === "lunch" && h >= 1 && h <= 5) h += 12;
  }
  return { hhmm: toHHMM(h * 60 + min) };
}

function placeOptions(plan: Plan, p: Person) {
  return (plan.places ?? []).map((x) => {
    const walk = (p.loc && walkMinutes(p.loc, x)) || x.walkMin;
    return { label: walk ? `${x.name} · ${walk} min` : x.name, value: x.name };
  });
}

/** Every place with at least one dish that fits ALL the group's restrictions, worked out once. */
async function ensurePlaces(plan: Plan, d: PlanDeps): Promise<boolean> {
  if (plan.places) return true;
  const origins = askers(plan).flatMap((p) => (p.loc ? [p.loc] : []));
  const all = await Promise.all(askers(plan).map((p) => d.restrictionsFor(`any;-;${p.phone}`)));
  const places = await d.places(unionRestrictions(all), origins, plan.meal);
  if (places.length === 0) {
    await fail(plan, d, "nothing nearby fits everyone's food restrictions");
    return false;
  }
  plan.places = places;
  // With no restrictions at all, how many places are there? (Only a count: nobody's restrictions are named.)
  plan.placesTotal = Math.max(places.length, (await d.places({ allergies: [], diets: [] }, [], plan.meal)).length);
  return true;
}

/** Someone who ticked only "can't make it": one message, with the apology in it, asking for another time. */
async function handleDecliners(plan: Plan, d: PlanDeps) {
  const decliners = live(plan).filter((p) => p.time?.answer && !p.altTried && picksOf(p.time).filter((v) => v !== "no").length === 0);
  for (const p of decliners) {
    p.altTried = true;
    // Every decliner is offered the same times outside the first options (not "outside what the last one was offered").
    const alts = altSlotsFor(plan, d.now());
    if (alts.length === 0) {
      p.out = "can't make it";
      continue;
    }
    plan.altSlots = [...new Set([...(plan.altSlots ?? []), ...alts])].sort();
    (plan.movedFor ??= []).push(p.name);
    p.alt = await ask(plan, p, d, {
      kind: "restaurant",
      plan: true,
      multi: true,
      title: `what other time works for ${plan.meal} ${plan.day}? ${pick(["sorry you can't make it. i'll ask the gang if they could move the slot", "aw sorry about that. i'll ask the gang if they could move the slot"])}`,
      options: [...alts.map((x) => ({ label: label(x), value: x })), { label: "none of these", value: "none" }],
    });
  }
}

/** The next message for this person that hasn't been sent yet: the place poll (after the location step) or a "would this time work?". */
const nextComing = (plan: Plan, p: Person) =>
  ((plan.places?.length ?? 0) >= 2 && !p.place && !p.out && (p === plan.organizer || timesOf(p).length > 0)) || (!!p.needsConfirm && !p.confirm);

/** True while this person has a question open or another message on the way. */
const stillMoving = (plan: Plan, p: Person) => !!pendingAsk(plan, p) || nextComing(plan, p);

/**
 * The step before the place poll: ask for their location (one message, the Find My request), then give them a little
 * while to share. Returns true when the place poll can go out. People already sharing skip straight through.
 */
async function locationStep(plan: Plan, p: Person, d: PlanDeps): Promise<boolean> {
  if (!p.loc) p.loc = await d.location.peek(p.phone);
  if (p.loc) return true;
  if (!p.locAsked) {
    p.locAsked = true;
    p.locAskedAt = d.now();
    p.chatGuid ||= await d.openChat(p.phone);
    await d.location.request(p.chatGuid, p.phone).catch((err) => console.warn(`  couldn't send a location request: ${(err as Error).message}`));
    return false;
  }
  return d.now() - (p.locAskedAt ?? 0) >= LOC_STEP_MS();
}

/**
 * The place poll goes to each person only when they have no other question open, and after the location step.
 * With a single spot that fits everyone there is nothing to vote on; it's just named when the plan is set.
 */
async function sendPlaceAsks(plan: Plan, d: PlanDeps) {
  const places = plan.places ?? [];
  if (places.length < 2) return;
  const n = places.length, total = plan.placesTotal ?? n;
  const title = `where to eat? ${n === total ? `all ${n} spots work for everyone's food restrictions` : `${n} of ${total} spots work for everyone's food restrictions`}. tap every one you're up for, or say anywhere`;
  const candidates = askers(plan).filter((p) => !p.place && !pendingAsk(plan, p) && (p === plan.organizer || timesOf(p).length > 0));
  await Promise.all(
    candidates.map(async (p) => {
      if (!(await locationStep(plan, p, d))) return;
      p.place = await ask(plan, p, d, { kind: "restaurant", plan: true, multi: true, title, options: placeOptions(plan, p) });
    }),
  );
}

/** Returns true if the stage changed, so the caller runs the next stage straight away. */
async function stageTime(plan: Plan, d: PlanDeps): Promise<boolean> {
  // "with you and Princy": the other invitees, not the organizer (who is named at the start).
  const withWho = (p: Person) => {
    const rest = plan.people.filter((x) => x !== p);
    return rest.length === 0 ? "you" : `you and ${names(rest)}`;
  };
  // One message each: the time poll. Everyone is asked at the same time; each person's next message waits for their answer.
  await Promise.all(
    live(plan)
      .filter((p) => !p.time)
      .map(async (p) => {
        const options = plan.slots.map((s) => ({ label: label(s), value: s }));
        p.time = await ask(plan, p, d, {
          kind: "restaurant",
          plan: true,
          multi: true,
          title: `what time works for ${plan.meal} ${plan.day}${plan.anchor ? ` around ${label(plan.anchor)}` : ""}? ${cap(plan.organizer.name)} is asking, with ${withWho(p)}`,
          options: [...options, { label: "can't make it", value: "no" }],
        });
      }),
  );
  if (!(await ensurePlaces(plan, d))) return false;
  await chase(plan, d, "time");
  await chase(plan, d, "alt");
  await handleDecliners(plan, d);
  await sendPlaceAsks(plan, d);
  if (waiting(plan, "time").length > 0 || waiting(plan, "alt").length > 0) {
    await hold(plan, d, "time");
    return false;
  }

  // Ticking "can't make it" along with times means the times; on its own (and no other time offered) they're out.
  for (const p of live(plan)) if (timesOf(p).length === 0) p.out = "can't make it";
  if (live(plan).length === 0) {
    await fail(plan, d, plan.people.some((p) => p.out === "didn't answer") ? "nobody answered in time" : `nobody can do ${plan.meal} ${plan.day}`);
    return false;
  }
  // If someone had to offer another time, the plan moves toward what they can do and the rest are asked to move.
  const all = [...plan.slots, ...(plan.altSlots ?? [])].sort();
  const offered = new Set(live(plan).flatMap((p) => picksOf(p.alt)).filter((v) => v !== "none"));
  const candidates = offered.size > 0 ? all.filter((x) => offered.has(x)) : plan.slots;
  const groups = [...live(plan).map(timesOf), ...(plan.anchor ? [[plan.anchor]] : [])];
  const { index, everyone } = chooseTime(candidates, groups);
  plan.proposed = candidates[index]!;
  if (everyone) {
    plan.timeChoice = plan.proposed;
    plan.stage = "place";
    return true;
  }
  plan.stage = "confirm";
  for (const p of [...live(plan).filter((x) => !timesOf(x).includes(plan.proposed!)), ...(plan.anchor && plan.anchor !== plan.proposed ? [plan.organizer] : [])]) p.needsConfirm = true;
  await sendConfirms(plan, d);
  return true;
}

/** "Would 9:00 work?" goes to each person who needs to move, but only once they have no other question open. */
async function sendConfirms(plan: Plan, d: PlanDeps) {
  const movedFor = (plan.movedFor ?? []).filter((n) => plan.people.some((p) => p.name === n && !p.out));
  for (const p of askers(plan)) {
    if (!p.needsConfirm || p.confirm || pendingAsk(plan, p)) continue;
    const why = movedFor.length > 0 && !movedFor.includes(p.name)
      ? `${cap(names(plan.people.filter((x) => movedFor.includes(x.name))))} can't make the earlier times`
      : "to get everyone on the same time";
    p.confirm = await ask(plan, p, d, {
      kind: "restaurant",
      plan: true,
      title: `does ${label(plan.proposed!)} work? ${why}`,
      options: [{ label: "yeah", value: "yes" }, { label: "nah", value: "no" }],
    });
  }
}

async function stageConfirm(plan: Plan, d: PlanDeps): Promise<boolean> {
  await sendPlaceAsks(plan, d);
  // Someone's "does this time work?" waits for their open place poll. If that poll could never time out here,
  // neither question would ever close and the plan would sit in this stage for good.
  await chase(plan, d, "place");
  await sendConfirms(plan, d);
  await chase(plan, d, "confirm");
  if (askers(plan).some((p) => p.needsConfirm && !p.confirm) || waiting(plan, "confirm").length > 0) {
    await hold(plan, d, "confirm");
    return false;
  }
  for (const p of live(plan)) if (p.confirm?.answer === "no") p.out = `couldn't do ${label(plan.proposed!)}`;
  if (plan.organizer.confirm?.answer === "no") {
    await fail(plan, d, `${label(plan.proposed!)} didn't work for you`);
    return false;
  }
  if (live(plan).length === 0) {
    await fail(plan, d, `nobody could do ${label(plan.proposed!)}`);
    return false;
  }
  plan.timeChoice = plan.proposed;
  plan.stage = "place";
  return true;
}

async function stagePlace(plan: Plan, d: PlanDeps): Promise<boolean> {
  if (!plan.places && !(await ensurePlaces(plan, d))) return false;
  await sendPlaceAsks(plan, d);
  await chase(plan, d, "place");
  if (waiting(plan, "place").length > 0 || askers(plan).some((p) => stillMoving(plan, p))) {
    await hold(plan, d, "place");
    return false;
  }
  if (live(plan).length === 0) {
    await fail(plan, d, "nobody picked a place in time");
    return false;
  }
  // Restrictions can arrive after the polls went out (someone texts an allergy), so check again before choosing.
  const origins = askers(plan).flatMap((p) => (p.loc ? [p.loc] : []));
  const now = await Promise.all(askers(plan).map((p) => d.restrictionsFor(`any;-;${p.phone}`)));
  const stillOk = new Set((await d.places(unionRestrictions(now), origins, plan.meal)).map((x) => x.name));
  const options = (plan.places ?? []).map((x) => x.name).filter((n) => stillOk.has(n));
  if (options.length === 0) {
    await fail(plan, d, "nothing nearby fits everyone's food restrictions");
    return false;
  }
  plan.placeChoice = winner(options, askers(plan).flatMap((p) => picksOf(p.place))) ?? options[0]!;
  plan.stage = "done";
  await announce(plan, d);
  return true;
}

async function announce(plan: Plan, d: PlanDeps) {
  const goers = live(plan);
  const when = `${label(plan.timeChoice!)} ${plan.day === "today" ? "today" : "tomorrow"}`;
  for (const p of goers) {
    const withWho = names([plan.organizer, ...goers.filter((x) => x !== p)]);
    await d.sendText(p.phone, `locked in: ${plan.meal} at ${plan.placeChoice}, ${when}. ${withWho} will be there`);
  }
  const dropped = plan.people.filter((p) => p.out);
  const lines = [`${plan.meal}'s set: ${plan.placeChoice} at ${when}. ${names(goers)} ${goers.length === 1 ? "is" : "are"} in`];
  if (dropped.length > 0) lines.push(dropped.map((p) => `${cap(p.name)} ${p.out}`).join(", "));
  await d.sendText(plan.organizer.phone, lines.join("\n\n"));

  // The card with the place, time, and who's coming (and how far each person walks).
  const place = plan.places?.find((x) => x.name === plan.placeChoice);
  const going = [plan.organizer, ...goers];
  const walks = going.map((p) => (place && p.loc ? walkMinutes(p.loc, place) : undefined));
  const farthest = Math.max(0, ...walks.map((w) => w ?? 0));
  const card: MeetupCard = {
    meal: plan.meal,
    place: plan.placeChoice!,
    time: label(plan.timeChoice!),
    date: dateLabel(plan.day, d.now()),
    people: going.map((p, i) => ({ name: p.name, ...(walks[i] !== undefined && { walkMin: walks[i]! }) })),
    ...(farthest > 0 && { note: `closest spot that works for everyone · farthest walk ${farthest} min` }),
  };
  for (const phone of going.map((p) => p.phone)) {
    await d.sendCard(phone, card).catch((err) => console.warn(`  plan ${plan.id}: couldn't send the card to ${phone}: ${(err as Error).message}`));
  }
  await finish(plan);
}

const dateLabel = (day: Day, nowMs: number) =>
  new Date(nowMs + (day === "tomorrow" ? 86_400_000 : 0)).toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric", timeZone: TIME_ZONE });

/** Move a plan as far forward as the answers allow. Safe to call repeatedly. */
export async function advance(plan: Plan, d: PlanDeps): Promise<void> {
  if (isOver(plan)) return;
  if (d.now() - plan.createdAt > MAX_PLAN_MS()) {
    // Closed even if the organizer can't be told: a send that keeps failing is one of the ways a plan gets stuck.
    plan.stage = "failed";
    await d.sendText(plan.organizer.phone, `couldn't get ${plan.meal} sorted: ran out of time waiting on everyone`).catch((err) => console.warn(`  plan ${plan.id}: couldn't tell the organizer it lapsed: ${(err as Error).message}`));
    await finish(plan);
    await savePlan(plan);
    console.log(`  plan ${plan.id}: dropped after ${Math.round(MAX_PLAN_MS() / 60_000)} minutes`);
    return;
  }
  if (stageOf(plan) === "ask_time") {
    // Waiting on the organizer's typed answer; that only lives as long as the context window.
    if (!contextOpen(plan, d.now())) {
      plan.stage = "failed";
      await d.sendText(plan.organizer.phone, `no worries, just tell me when you want to plan ${plan.meal}`);
      await finish(plan);
      await savePlan(plan);
    }
    return;
  }
  await readAnswers(plan, d);
  for (let i = 0; i < 6; i++) {
    const before: Stage = stageOf(plan);
    const stage = stageOf(plan);
    const changed = stage === "time" ? await stageTime(plan, d) : stage === "confirm" ? await stageConfirm(plan, d) : stage === "place" ? await stagePlace(plan, d) : false;
    await savePlan(plan);
    if (!changed || stageOf(plan) === before || isOver(plan)) break;
  }
}

// ---------- entry points ----------

const matchUser = (users: Awaited<ReturnType<PlanDeps["users"]>>, said: string) => {
  const q = said.trim().toLowerCase();
  const exact = users.filter((u) => (u.firstName ?? "").toLowerCase() === q);
  if (exact.length === 1) return { user: exact[0]! };
  const prefix = users.filter((u) => (u.firstName ?? "").toLowerCase().startsWith(q));
  if (exact.length === 0 && prefix.length === 1) return { user: prefix[0]! };
  return { ambiguous: exact.length > 1 || prefix.length > 1 };
};

export interface StartArgs {
  meal?: string;
  day?: string;
  people?: unknown;
  /** A time they named ("7", "around noon"). */
  time?: unknown;
  /** They said any time is fine. */
  anytime?: unknown;
  earliest_hour?: unknown;
  latest_hour?: unknown;
}

export async function startPlan(d: PlanDeps, who: { phone: string; chatGuid: string }, args: StartArgs) {
  const meal: Meal = args.meal === "lunch" || args.meal === "breakfast" ? args.meal : "dinner";
  const day: Day = args.day === "tomorrow" ? "tomorrow" : "today";
  const users = await d.users();
  const me = users.find((u) => u.phoneNumber === who.phone);
  const people: Person[] = [];
  const notFound: string[] = [], ambiguous: string[] = [];
  for (const said of Array.isArray(args.people) ? (args.people as unknown[]).filter((x): x is string => typeof x === "string") : []) {
    const m = matchUser(users, said);
    if (!m.user) (m.ambiguous ? ambiguous : notFound).push(said);
    else if (m.user.phoneNumber !== who.phone && !people.some((p) => p.phone === m.user.phoneNumber)) {
      people.push({ name: (m.user.firstName ?? said).toLowerCase(), phone: m.user.phoneNumber, chatGuid: `any;-;${m.user.phoneNumber}` });
    }
  }
  if (people.length === 0) return { error: "nobody to plan with", not_found: notFound, ambiguous };

  const num = (v: unknown) => (typeof v === "number" && v >= 0 && v <= 23 ? v : undefined);
  const e = num(args.earliest_hour), l = num(args.latest_hour);
  const named = typeof args.time === "string" ? parseTimeAnswer(args.time, meal) : undefined;
  const anchor = named && "hhmm" in named ? named.hhmm : undefined;
  // No time, no range and no "anytime": the organizer is asked what time they're thinking before anyone else is texted.
  const mustAsk = anchor === undefined && e === undefined && l === undefined && args.anytime !== true && !(named && "anytime" in named);
  // Say so up front if the meal is over for the day, before asking anyone anything (the default window can't be met).
  if (mustAsk && slotsFor(meal, day, d.now()).length < 2) return { error: `too late for ${meal} ${day}; offer tomorrow or a later meal, and don't say you're texting anyone` };
  const slots = mustAsk
    ? []
    : anchor
      ? slotsAround(anchor, day, d.now())
      : slotsFor(meal, day, d.now(), { ...(e !== undefined && { earliestHour: e }), ...(l !== undefined && { latestHour: l }) });
  if (!mustAsk && (slots.length < 2 || (anchor && !slots.includes(anchor)))) return { error: `too late for ${meal} ${day}; offer tomorrow or a later time, and don't say you're texting anyone` };

  const plan: Plan = {
    id: Math.random().toString(36).slice(2, 8),
    createdAt: d.now(),
    contextUntil: d.now() + CONTEXT_MS(),
    meal, day, people, slots,
    organizer: { name: (me?.firstName ?? "your friend").toLowerCase(), phone: who.phone, chatGuid: who.chatGuid },
    stage: mustAsk ? "ask_time" : "time",
    ...(anchor && { anchor }),
  };
  await savePlan(plan);
  await setActive([...(await activeIds()), plan.id]);
  for (const p of [plan.organizer, ...people]) {
    await putState(pointerKey(p.phone), plan.id, pointerTtl());
    await putState(voteKey(p.phone), plan.id, PLAN_TTL);
  }
  console.log(`  plan ${plan.id}: ${meal} ${day} with ${people.map((p) => p.name).join(", ")}${mustAsk ? " (asking the organizer for a time)" : ""}`);
  if (mustAsk) {
    const question = pick([`what time are you thinking for ${meal} ${day === "today" ? "" : day}? or just say anytime`, `what time works for you for ${meal} ${day === "today" ? "" : day}? or say anytime`]).replace(/\s+\?/, "?");
    await d.sendText(who.phone, question);
    return { started: true, planId: plan.id, asking_time: true, sent_text: question, texting: people.map((p) => cap(p.name)), not_found: notFound, ambiguous };
  }
  await withLease(plan.id, () => advance(plan, d), 5000);
  return { started: true, planId: plan.id, texting: people.map((p) => cap(p.name)), not_found: notFound, ambiguous, times: slots.map(label) };
}

/**
 * The check that runs every minute: read answers, nudge, and move every active plan forward. Photon doesn't forward poll
 * taps, so this is what notices them: with `spanMs` it keeps looking every 3 seconds for most of the minute instead of once.
 */
export async function tickPlans(d: PlanDeps, spanMs = 0) {
  const until = Date.now() + spanMs;
  for (;;) {
    const ids = await activeIds();
    for (const id of ids) {
      await withLease(id, async () => {
        const plan = await getPlan(id);
        // Gone, or over but still listed: off the list, or this check would keep looking at it for the whole minute, every minute.
        if (!plan || isOver(plan)) return void (await setActive((await activeIds()).filter((x) => x !== id)));
        await advance(plan, d);
      }).catch((err) => console.warn(`  plan ${id} tick failed: ${(err as Error).message}`));
    }
    if (ids.length === 0 || Date.now() + 3000 >= until) return;
    await new Promise((r) => setTimeout(r, 3000));
  }
}

/** Keep a fresh plan moving quickly (every few seconds) for a while, so replies feel instant. */
export async function watchPlan(d: PlanDeps, id: string, forMs: number) {
  const until = Date.now() + forMs;
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, 3000));
    const done = await withLease(id, async () => {
      const plan = await getPlan(id);
      if (!plan || isOver(plan)) return true;
      await advance(plan, d);
      return isOver(plan);
    });
    if (done) return;
  }
}

const ANYWHERE = /\b(any ?where|any ?(place|spot|one|of them|of 'em)|all of (them|'em)|everything|i'?m (good|fine|easy) with (any|all)|don'?t care|doesn'?t matter|no preference|you pick|up to you|whatever)\b/i;

/** Titles of the polls the plan sends, so a vote can be told apart from a vote on a dish or restaurant poll. */
export const isPlanPollTitle = (title: string | undefined) => /^(what time works for |where to eat\?|does .+ work\?|what other time works for )/i.test(title ?? "");

/**
 * Someone just tapped a plan poll. Don't wait for the once-a-minute check: look right away, and keep looking every
 * second until their tap has settled and been counted (a few seconds), so the next message goes out straight away.
 * Returns false if they have no live plan.
 */
export async function onPlanVote(d: PlanDeps, phone: string, forMs = 70_000): Promise<boolean> {
  const id = await getState<string>(voteKey(phone));
  if (!id) return false;
  const answeredNow = (plan: Plan) => {
    const person = askers(plan).find((x) => x.phone === phone);
    return person ? (["time", "confirm", "place", "alt"] as const).filter((k) => person[k]?.answer).length : -1;
  };
  let before: number | undefined;
  const until = Date.now() + forMs;
  while (Date.now() < until) {
    const done = await withLease(id, async () => {
      const plan = await getPlan(id);
      if (!plan || isOver(plan)) return true;
      before ??= answeredNow(plan);
      await advance(plan, d);
      const now = answeredNow(plan);
      const person = askers(plan).find((x) => x.phone === phone);
      // Done once their tap is counted and nothing more is about to be sent to them (the place poll waits on their location).
      return now < 0 || (now > before && !!person && !nextComing(plan, person));
    });
    if (done) return true;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return true;
}

const pendingAsk = (plan: Plan, p: Person): { key: AskKey; ask: Ask } | undefined => {
  for (const key of ["time", "confirm", "place", "alt"] as const) if (p[key] && !p[key]!.answer) return { key, ask: p[key]! };
  return undefined;
};

/** The organizer's typed answer to "what time are you thinking?". Always handled (true), so it never leaks into normal chat. */
async function answerTime(plan: Plan, d: PlanDeps, text: string): Promise<boolean> {
  const to = plan.organizer.phone;
  if (/\b(never ?mind|nvm|cancel|forget it|drop it|scrap)\b/i.test(text)) {
    plan.stage = "failed";
    await d.sendText(to, "ok, dropped it. just tell me when you want to plan something");
    await finish(plan);
    await savePlan(plan);
    return true;
  }
  const t = parseTimeAnswer(text, plan.meal);
  if (!t) {
    await d.sendText(to, "didn't catch that. what time, like 7 or 7:30? or say anytime");
    return true;
  }
  if ("hhmm" in t) {
    const slots = slotsAround(t.hhmm, plan.day, d.now());
    if (!slots.includes(t.hhmm)) {
      await d.sendText(to, `${label(t.hhmm)} is already past or too early. what other time?`);
      return true;
    }
    plan.anchor = t.hhmm;
    plan.slots = slots;
  } else {
    plan.slots = slotsFor(plan.meal, plan.day, d.now());
    if (plan.slots.length < 2) {
      await fail(plan, d, `too late for ${plan.meal} ${plan.day}`);
      await savePlan(plan);
      return true;
    }
  }
  plan.stage = "time";
  await savePlan(plan);
  await advance(plan, d);
  return true;
}

/**
 * Someone typed instead of tapping. If it answers the question they were asked, count it. Returns whether it did.
 * Only while the plan's shared context is open (5 minutes from the request); after that it's ordinary chat.
 */
export async function handleReply(d: PlanDeps, phone: string, text: string): Promise<boolean> {
  const id = await getState<string>(pointerKey(phone));
  if (!id) return false;
  return (
    (await withLease(
      id,
      async () => {
        const plan = await getPlan(id);
        if (!plan || isOver(plan) || !contextOpen(plan, d.now())) return false;
        if (stageOf(plan) === "ask_time") return phone === plan.organizer.phone ? answerTime(plan, d, text) : false;
        const person = askers(plan).find((p) => p.phone === phone);
        if (!person) return false;
        const pending = pendingAsk(plan, person);
        if (!pending) return false;
        const options = pending.ask.rec.options;
        // "anywhere" / "anything" / "i don't care" on the place question means every spot on the list is fine.
        if (pending.key === "place" && ANYWHERE.test(text)) {
          pending.ask.picks = options.map((o) => o.value);
          pending.ask.answer = pending.ask.picks[0]!;
          console.log(`  plan ${plan.id}: ${person.name} is fine with anywhere (${options.length} spots)`);
          await advance(plan, d);
          return true;
        }
        const idx = await d.interpret(pending.ask.rec.title, options.map((o) => o.label), text);
        if (idx < 0 || idx >= options.length) return false;
        pending.ask.answer = options[idx]!.value;
        pending.ask.picks = [options[idx]!.value];
        console.log(`  plan ${plan.id}: ${person.name} answered ${pending.key} by text: ${pending.ask.answer}`);
        // advance tells them to hang tight if the others haven't answered yet.
        await advance(plan, d);
        return true;
      },
      8000,
    )) ?? false
  );
}

/**
 * What the chat model may say about a plan someone is in, while its context window is open. Logistics only:
 * names, times, who has answered. Never anyone's allergies, diet or health (those stay private).
 */
export async function planNoteFor(phone: string, nowMs: number = Date.now()): Promise<string | undefined> {
  const id = await getState<string>(pointerKey(phone));
  const plan = id ? await getPlan(id) : undefined;
  if (!plan || isOver(plan) || !contextOpen(plan, nowMs)) return undefined;
  const others = plan.people.filter((p) => !p.out);
  const answered = (key: AskKey) => askers(plan).filter((p) => p[key]?.answer && p[key]!.answer !== "no-answer");
  const status =
    stageOf(plan) === "ask_time"
      ? `waiting for ${cap(plan.organizer.name)} to say what time`
      : stageOf(plan) === "time"
        ? `everyone was texted time options${plan.anchor ? ` around ${label(plan.anchor)}` : ""} and the places that work for the group. answered so far: ${names(answered("time")) || "nobody"}. still deciding: ${names(askers(plan).filter((p) => p.time && !p.time.answer)) || "nobody"}`
        : stageOf(plan) === "confirm"
          ? `proposed ${label(plan.proposed!)}; checking who can move to it`
          : `time is ${label(plan.timeChoice!)}; waiting on place votes from ${names(askers(plan).filter((p) => p.place && !p.place.answer)) || "nobody"}`;
  const out = plan.people.filter((p) => p.out);
  const spots = plan.places ? ` the place poll has ${plan.places.length} of ${plan.placesTotal ?? plan.places.length} spots: only those have something that works for everyone's food restrictions (don't say whose restrictions limit it).` : "";
  return `${cap(plan.organizer.name)} asked to plan ${plan.meal} ${plan.day} with ${names(others)}. ${status}.${spots}${out.length > 0 ? ` can't make it: ${names(out)}.` : ""}`;
}

// ---------- pacing ----------

const PACE_MS = () => Number(process.env.PLAN_PACE_MS ?? 2000);
const lanes = new Map<string, Promise<unknown>>();
const lastSent = new Map<string, number>();
/**
 * Run a send for one person, at least PACE_MS after their previous one. A person's sends queue up in order;
 * different people are independent. A single message after a quiet spell goes out at once.
 */
export function paced<T>(phone: string, fn: () => Promise<T>): Promise<T> {
  const run = (lanes.get(phone) ?? Promise.resolve()).catch(() => {}).then(async () => {
    const wait = (lastSent.get(phone) ?? 0) + PACE_MS() - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    try {
      return await fn();
    } finally {
      lastSent.set(phone, Date.now());
    }
  });
  lanes.set(phone, run);
  return run;
}
const phoneOf = (chatGuid: string) => chatGuid.replace(/^any;-;/, "");

// ---------- the real dependencies ----------

export function realPlanDeps(
  app: any,
  sendDm: (app: any, phone: string, text: string) => Promise<string>,
  sendImage?: (app: any, phone: string, image: Buffer) => Promise<void>,
  sendCardLink?: (app: any, phone: string, url: string, card: MeetupCard) => Promise<void>,
  openDm?: (app: any, phone: string) => Promise<string>,
): PlanDeps {
  return {
    now: () => Date.now(),
    sendText: (phone, text) => paced(phone, () => sendDm(app, phone, text)),
    openChat: async (phone) => (openDm ? openDm(app, phone) : `any;-;${phone}`),
    polls: { send: (chatGuid, spec) => paced(phoneOf(chatGuid), () => realPolls.send(chatGuid, spec)), read: readVotes },
    location: { peek: peekLocation, request: requestLocation },
    // A Spectrum app card that links to the plan page; if that can't be sent, fall back to the picture.
    sendCard: (phone, card) =>
      paced(phone, async () => {
        const url = sendCardLink ? await publishCard(card).catch(() => undefined) : undefined;
        if (url && sendCardLink) {
          try {
            await sendCardLink(app, phone, url, card);
            return;
          } catch (err) {
            console.warn(`  card link failed, sending the picture instead: ${(err as Error).message}`);
          }
        }
        if (sendImage) await sendImage(app, phone, await meetupJpeg(card));
      }),
    // People we have profiles for come first (their names are the ones we know), then anyone else Photon knows.
    users: async () => {
      const [known, photon] = await Promise.all([listProfiles().catch(() => []), (await import("./invite.js")).listUsers().catch(() => [])]);
      const mine = known.map((u) => ({ firstName: u.name, lastName: null as string | null, phoneNumber: u.phone }));
      return [...mine, ...photon.filter((u) => !mine.some((m) => m.phoneNumber === u.phoneNumber))];
    },
    places: async (restrictions, origins, meal) => {
      // Coffee shops and drink counters don't make the list for dinner.
      const rows = (await listRestaurants(constraintsFor(restrictions), ["meal"])).filter((r) => servesMeal(r.restaurantId, meal));
      // Fairest first: the shortest worst-case walk, then the shortest total. With nobody's location, the catalog's order.
      const ranked = rows
        .map((r, i) => {
          const km = origins.map((o) => haversineKm(o, r));
          return { r, km: origins.length ? Math.max(...km) : i * 0.001, total: km.reduce((a, b) => a + b, 0) };
        })
        .sort((a, b) => a.km - b.km || a.total - b.total);
      // Every place that has something for the whole group, fairest first (not just three).
      return ranked.map(({ r, km }) => ({
        name: r.restaurantName,
        lat: r.lat,
        lng: r.lng,
        ...(origins.length > 0 && { walkMin: Math.max(1, Math.round(km / WALK_KM_PER_MIN)) }),
      }));
    },
    organizerOrigin: async (chatGuid) => (await getState<Origin>(`loc#${chatGuid}`)) ?? undefined,
    // What each person told this chat, plus whatever is saved on their profile.
    restrictionsFor: async (chatGuid) => {
      const said = await restrictionsFor(chatGuid);
      const profile = await getUser(chatGuid.replace(/^any;-;/, ""));
      return profile ? unionRestrictions([said, { allergies: profile.allergies, diets: profile.diets }]) : said;
    },
    interpret: async (question, options, text) => {
      try {
        const out = await converseTool<{ choice?: number }>({
          system: "Someone was asked a question with fixed options. Decide which ONE option their reply chooses. Be literal: '7' or 'seven' means the 7:00 option; 'can't' / 'no' / 'busy' means the can't-make-it or no option; 'yes' / 'sure' / 'works' means yes. If the reply isn't an answer to the question (small talk, a different question), choose -1.",
          user: `Question: ${question}\nOptions:\n${options.map((o, i) => `${i}: ${o}`).join("\n")}\n\nTheir reply: ${text}`,
          toolName: "choose",
          toolDescription: "Report the chosen option index, or -1.",
          schema: { type: "object", properties: { choice: { type: "integer", description: "Option index, or -1 if not an answer" } }, required: ["choice"] },
          maxTokens: 60,
        });
        return typeof out.choice === "number" ? out.choice : -1;
      } catch {
        return -1;
      }
    },
  };
}
