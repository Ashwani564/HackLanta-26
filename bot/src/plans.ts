// "Schedule dinner with Ashwani and Princy": the bot texts each person separately, settles a time and a place,
// then tells the organizer.
//
//   time     each person gets a poll of times (tap every one that works) and a Find My request, so the
//            place can be fair to everyone. The bot waits until they stop tapping; it never replies per tap.
//   confirm  anyone not free at the time that fits the most people is asked "does 7:00 work?" (a no drops them)
//   place    everyone gets a poll of the 3 places closest to everyone that fit ALL their food restrictions
//            (tap every one you're up for) -> most votes wins
//   done     everyone gets the details and a card, and so does the organizer
//
// Anyone who has answered while others haven't is told to hang tight, once per question.
//
// People answer whenever they like, so a plan can't live inside one running function. Its state is saved, and
// `advance` is called from (a) a check every minute, (b) the person who asked, for the first few minutes, and
// (c) a typed reply. `advance` is safe to call any number of times; a short lease keeps two callers apart.
import { converseTool } from "../../src/llm/bedrock.js";
import { haversineKm } from "../../src/pipeline/filter.js";
import { listRestaurants } from "../../src/rag/store.js";
import { type Origin, type Restrictions, constraintsFor, pickVaried, restrictionsFor, unionRestrictions } from "./dining.js";
import { peekLocation, requestLocation } from "./findmy.js";
import { type MeetupCard, meetupJpeg } from "./meetup-card.js";
import { type PollRecord, type PollSpec, readVotes, realPolls } from "./polls.js";
import { getState, leaseOnce, putState, releaseLease } from "./store.js";
import { TIME_ZONE } from "./day.js";

export type Meal = "dinner" | "lunch" | "breakfast";
export type Day = "today" | "tomorrow";
type Stage = "time" | "confirm" | "place" | "done" | "failed";
type AskKey = "time" | "confirm" | "place";

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
  organizer: { name: string; phone: string; chatGuid: string; loc?: Origin; locAsked?: boolean };
  people: Person[];
  /** Time options as "HH:MM", in order. */
  slots: string[];
  stage: Stage;
  proposed?: string;
  timeChoice?: string;
  places?: Place[];
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
  /** `read` returns every option currently ticked (empty if none). */
  polls: { send(chatGuid: string, spec: PollSpec): Promise<PollRecord>; read(rec: PollRecord): Promise<string[]> };
  /** Find My: a quiet look at where someone is, and the share-request card (never waits for the tap). */
  location: { peek(phone: string): Promise<Origin | undefined>; request(chatGuid: string, phone: string): Promise<void> };
  /** The "it's on" card, sent to one person as a picture. */
  sendCard(phone: string, card: MeetupCard): Promise<void>;
  users(): Promise<{ firstName: string | null; lastName: string | null; phoneNumber: string }[]>;
  /** Up to three places that work for all of these restrictions, the fairest walk for everyone first. */
  places(restrictions: Restrictions, origins: Origin[]): Promise<Place[]>;
  organizerOrigin(chatGuid: string): Promise<Origin | undefined>;
  /** Which option (index) a typed reply means, or -1 if it isn't an answer. */
  interpret(question: string, options: string[], text: string): Promise<number>;
  restrictionsFor(chatGuid: string): Promise<Restrictions>;
}

const minutes = (m: number) => m * 60_000;
const NUDGE_MS = () => minutes(Number(process.env.PLAN_NUDGE_MIN ?? 10));
const GIVE_UP_MS = () => minutes(Number(process.env.PLAN_GIVE_UP_MIN ?? 40));
/** A multi-pick poll counts once nothing has changed for this long. */
const SETTLE_MS = () => Number(process.env.PLAN_SETTLE_SEC ?? 15) * 1000;
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
const ACTIVE = "plans#active";
const PLAN_TTL = 3 * 86400;

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
/** Reads the stage fresh each time (the stage functions change it, which TypeScript can't see through). */
const stageOf = (plan: Plan): Stage => plan.stage;
const isOver = (plan: Plan) => stageOf(plan) === "done" || stageOf(plan) === "failed";
const names = (ps: readonly { name: string }[]) => {
  const n = ps.map((p) => cap(p.name));
  return n.length <= 1 ? (n[0] ?? "") : `${n.slice(0, -1).join(", ")} and ${n[n.length - 1]}`;
};

async function ask(plan: Plan, p: Person, d: PlanDeps, text: string, spec: PollSpec): Promise<Ask> {
  p.chatGuid = await d.sendText(p.phone, text);
  return { rec: await d.polls.send(p.chatGuid, spec), sentAt: d.now() };
}

const picksOf = (a?: Ask): string[] => a?.picks ?? (a?.answer ? [a.answer] : []);

async function readAnswers(plan: Plan, d: PlanDeps) {
  for (const p of live(plan)) {
    for (const key of ["time", "confirm", "place"] as const) {
      const a = p[key];
      if (!a || a.answer) continue;
      try {
        const votes = await d.polls.read(a.rec);
        if (votes.length === 0) {
          a.sig = undefined;
          continue;
        }
        if (!a.rec.multi) {
          a.answer = votes[0]!;
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
  for (const p of live(plan)) {
    const a = p[key];
    if (!a || a.answer) continue;
    if (now - a.sentAt > GIVE_UP_MS()) {
      p.out = "didn't answer";
      console.log(`  plan ${plan.id}: ${p.name} timed out on ${key}`);
    } else if (!a.nudged && now - a.sentAt > NUDGE_MS()) {
      a.nudged = true;
      await d.sendText(p.phone, pick(["still need your pick on that poll 👆", "when you get a sec, tap one on the poll above", "no rush, just need your pick on the poll"]));
    }
  }
}

const waiting = (plan: Plan, key: AskKey) => live(plan).filter((p) => p[key] && !p[key]!.answer);

async function fail(plan: Plan, d: PlanDeps, why: string) {
  plan.stage = "failed";
  await d.sendText(plan.organizer.phone, `couldn't get ${plan.meal} sorted: ${why}`);
  await finish(plan);
}

async function finish(plan: Plan) {
  for (const p of plan.people) await putState(pointerKey(p.phone), null, 1);
  await setActive((await activeIds()).filter((x) => x !== plan.id));
}

/** Someone has answered but others haven't: tell them once to hang tight, instead of leaving them wondering. */
async function hold(plan: Plan, d: PlanDeps, key: AskKey) {
  if (waiting(plan, key).length === 0) return;
  for (const p of live(plan)) {
    if (!p[key]?.answer || p.held?.[key]) continue;
    (p.held ??= {})[key] = true;
    await d.sendText(p.phone, pick(["got it, hang tight while i check with the others", "nice, hang tight while i check with everyone else", "ok got it. hang tight, checking with the others"]));
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

/** Returns true if the stage changed, so the caller runs the next stage straight away. */
async function stageTime(plan: Plan, d: PlanDeps): Promise<boolean> {
  // "with you and Princy": the other invitees, not the organizer (who is named at the start).
  const withWho = (p: Person) => {
    const rest = plan.people.filter((x) => x !== p);
    return rest.length === 0 ? "you" : `you and ${names(rest)}`;
  };
  for (const p of live(plan)) {
    if (p.time) continue;
    const options = plan.slots.map((s) => ({ label: label(s), value: s }));
    p.time = await ask(
      plan, p, d,
      `hey ${cap(p.name)}, ${cap(plan.organizer.name)} wants to do ${plan.meal} ${plan.day} with ${withWho(p)}. tap every time that works for you (if you've got allergies, text me so i can factor them in)`,
      { kind: "restaurant", plan: true, multi: true, title: `what time works for ${plan.meal} ${plan.day}?`, options: [...options, { label: "can't make it", value: "no" }] },
    );
    await askLocation(d, p);
  }
  await chase(plan, d, "time");
  if (waiting(plan, "time").length > 0) {
    await hold(plan, d, "time");
    return false;
  }

  // Ticking "can't make it" along with times means the times; on its own it means they're out.
  const timesOf = (p: Person) => picksOf(p.time).filter((v) => v !== "no");
  for (const p of live(plan)) if (timesOf(p).length === 0) p.out = "can't make it";
  if (live(plan).length === 0) {
    await fail(plan, d, plan.people.some((p) => p.out === "didn't answer") ? "nobody answered in time" : `nobody can do ${plan.meal} ${plan.day}`);
    return false;
  }
  const { index, everyone } = chooseTime(plan.slots, live(plan).map(timesOf));
  plan.proposed = plan.slots[index]!;
  if (everyone) {
    plan.timeChoice = plan.proposed;
    plan.stage = "place";
    return true;
  }
  plan.stage = "confirm";
  for (const p of live(plan)) {
    if (picksOf(p.time).includes(plan.proposed)) continue;
    p.confirm = await ask(plan, p, d, `${pick(["thanks!", "got it,", "ok,"])} to get everyone on the same time, would ${label(plan.proposed)} work for you instead?`, {
      kind: "restaurant",
      plan: true,
      title: `does ${label(plan.proposed)} work?`,
      options: [{ label: "yeah", value: "yes" }, { label: "nah", value: "no" }],
    });
  }
  return true;
}

async function stageConfirm(plan: Plan, d: PlanDeps): Promise<boolean> {
  await chase(plan, d, "confirm");
  if (waiting(plan, "confirm").length > 0) {
    await hold(plan, d, "confirm");
    return false;
  }
  for (const p of live(plan)) if (p.confirm?.answer === "no") p.out = `couldn't do ${label(plan.proposed!)}`;
  if (live(plan).length === 0) {
    await fail(plan, d, `nobody could do ${label(plan.proposed!)}`);
    return false;
  }
  plan.timeChoice = plan.proposed;
  plan.stage = "place";
  return true;
}

async function stagePlace(plan: Plan, d: PlanDeps): Promise<boolean> {
  if (!plan.places) {
    // Where is everyone? People who haven't shared get a few minutes, then we go with what we have.
    const everyone: { phone: string; loc?: Origin }[] = [plan.organizer, ...live(plan)];
    for (const p of everyone) if (!p.loc) p.loc = await d.location.peek(p.phone);
    plan.locWaitUntil ??= d.now() + LOC_WAIT_MS();
    if (everyone.some((p) => !p.loc) && d.now() < plan.locWaitUntil) {
      for (const p of live(plan)) {
        if (p.held?.loc) continue;
        (p.held ??= {}).loc = true;
        await d.sendText(p.phone, `${pick(["cool", "nice", "perfect"])}, ${label(plan.timeChoice!)} it is. hang tight while i find a spot that's close to everyone`);
      }
      return false;
    }
    let origins = everyone.flatMap((p) => (p.loc ? [p.loc] : []));
    if (origins.length === 0) origins = [await d.organizerOrigin(plan.organizer.chatGuid)].flatMap((o) => (o ? [o] : []));
    // The group's food restrictions are everyone's combined, including the organizer's.
    const all = await Promise.all([plan.organizer, ...live(plan)].map((p) => d.restrictionsFor(`any;-;${p.phone}`)));
    const places = await d.places(unionRestrictions(all), origins);
    if (places.length === 0) {
      await fail(plan, d, "nothing nearby fits everyone's food restrictions");
      return false;
    }
    plan.places = places;
    for (const p of live(plan)) {
      // Each person sees their own walk when we know where they are.
      const options = places.map((x) => {
        const walk = (p.loc && walkMinutes(p.loc, x)) || x.walkMin;
        return { label: walk ? `${x.name} · ${walk} min` : x.name, value: x.name };
      });
      p.place = await ask(plan, p, d, `${p.held?.loc ? "ok, found" : `${pick(["cool", "nice", "perfect"])}, ${label(plan.timeChoice!)} it is. found`} the spots closest to everyone. tap every one you're up for`, {
        kind: "restaurant",
        plan: true,
        multi: true,
        title: "where to eat?",
        options,
      });
    }
    return false;
  }
  await chase(plan, d, "place");
  if (waiting(plan, "place").length > 0) {
    await hold(plan, d, "place");
    return false;
  }
  if (live(plan).length === 0) {
    await fail(plan, d, "nobody picked a place in time");
    return false;
  }
  plan.placeChoice = winner(plan.places.map((x) => x.name), live(plan).flatMap((p) => picksOf(p.place))) ?? plan.places[0]!.name;
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
  const slots = slotsFor(meal, day, d.now(), { ...(e !== undefined && { earliestHour: e }), ...(l !== undefined && { latestHour: l }) });
  if (slots.length < 2) return { error: `too late for ${meal} ${day}; offer tomorrow or a later time` };

  const plan: Plan = {
    id: Math.random().toString(36).slice(2, 8),
    createdAt: d.now(),
    meal, day, people, slots,
    organizer: { name: (me?.firstName ?? "your friend").toLowerCase(), phone: who.phone, chatGuid: who.chatGuid },
    stage: "time",
  };
  await askLocation(d, plan.organizer);
  await savePlan(plan);
  await setActive([...(await activeIds()), plan.id]);
  for (const p of people) await putState(pointerKey(p.phone), plan.id, PLAN_TTL);
  await withLease(plan.id, () => advance(plan, d), 5000);
  console.log(`  plan ${plan.id}: ${meal} ${day} with ${people.map((p) => p.name).join(", ")}`);
  return { started: true, planId: plan.id, texting: people.map((p) => cap(p.name)), not_found: notFound, ambiguous, times: slots.map(label) };
}

/** The check that runs every minute: read answers, nudge, and move every active plan forward. */
export async function tickPlans(d: PlanDeps) {
  for (const id of await activeIds()) {
    await withLease(id, async () => {
      const plan = await getPlan(id);
      if (!plan) return void (await setActive((await activeIds()).filter((x) => x !== id)));
      await advance(plan, d);
    }).catch((err) => console.warn(`  plan ${id} tick failed: ${(err as Error).message}`));
  }
}

/** Keep a fresh plan moving quickly (every few seconds) for a while, so replies feel instant. */
export async function watchPlan(d: PlanDeps, id: string, forMs: number) {
  const until = Date.now() + forMs;
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, 4000));
    const done = await withLease(id, async () => {
      const plan = await getPlan(id);
      if (!plan || isOver(plan)) return true;
      await advance(plan, d);
      return isOver(plan);
    });
    if (done) return;
  }
}

const pendingAsk = (plan: Plan, p: Person): { key: AskKey; ask: Ask } | undefined => {
  for (const key of ["time", "confirm", "place"] as const) if (p[key] && !p[key]!.answer) return { key, ask: p[key]! };
  return undefined;
};

/** Someone typed instead of tapping. If it answers the question they were asked, count it. Returns whether it did. */
export async function handleReply(d: PlanDeps, phone: string, text: string): Promise<boolean> {
  const id = await getState<string>(pointerKey(phone));
  if (!id) return false;
  return (
    (await withLease(
      id,
      async () => {
        const plan = await getPlan(id);
        const person = plan?.people.find((p) => p.phone === phone && !p.out);
        if (!plan || !person || isOver(plan)) return false;
        const pending = pendingAsk(plan, person);
        if (!pending) return false;
        const options = pending.ask.rec.options;
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

// ---------- the real dependencies ----------

export function realPlanDeps(
  app: any,
  sendDm: (app: any, phone: string, text: string) => Promise<string>,
  sendImage?: (app: any, phone: string, image: Buffer) => Promise<void>,
): PlanDeps {
  return {
    now: () => Date.now(),
    sendText: (phone, text) => sendDm(app, phone, text),
    polls: { send: realPolls.send, read: readVotes },
    location: { peek: peekLocation, request: requestLocation },
    sendCard: async (phone, card) => void (sendImage && (await sendImage(app, phone, await meetupJpeg(card)))),
    users: async () => (await import("./invite.js")).listUsers(),
    places: async (restrictions, origins) => {
      const rows = await listRestaurants(constraintsFor(restrictions), ["meal"]);
      // Fairest first: the shortest worst-case walk, then the shortest total. With nobody's location, the catalog's order.
      const ranked = rows
        .map((r, i) => {
          const km = origins.map((o) => haversineKm(o, r));
          return { r, km: origins.length ? Math.max(...km) : i * 0.001, total: km.reduce((a, b) => a + b, 0) };
        })
        .sort((a, b) => a.km - b.km || a.total - b.total);
      return pickVaried(ranked, 3).map(({ r, km }) => ({
        name: r.restaurantName,
        lat: r.lat,
        lng: r.lng,
        ...(origins.length > 0 && { walkMin: Math.max(1, Math.round(km / WALK_KM_PER_MIN)) }),
      }));
    },
    organizerOrigin: async (chatGuid) => (await getState<Origin>(`loc#${chatGuid}`)) ?? undefined,
    restrictionsFor,
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
