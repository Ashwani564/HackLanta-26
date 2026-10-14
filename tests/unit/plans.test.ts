import assert from "node:assert/strict";
import test from "node:test";
import { type Place, type Plan, type PlanDeps, advance, altSlotsFor, chooseTime, handleReply, isPlanPollTitle, label, minutesNow, onPlanVote, paced, parseTimeAnswer, planNoteFor, proposeTime, slotsAround, slotsFor, startPlan, tickPlans, winner } from "../../bot/src/plans.js";
import { getState, putState } from "../../bot/src/store.js";
import type { PollRecord, PollSpec } from "../../bot/src/polls.js";
import type { MeetupCard } from "../../bot/src/meetup-card.js";
import { meetupJpeg, useBundledFonts, wrapName } from "../../bot/src/meetup-card.js";
import { existsSync } from "node:fs";

const ASHAR = "+11111111111", ASHWANI = "+12222222222", PRINCY = "+13333333333";
// 3:00 PM in New York (19:00 UTC), so dinner slots from 5:30 PM are all still ahead.
const AFTERNOON = Date.UTC(2026, 9, 10, 19, 0);

// Georgia State, Five Points, and a few blocks away: close enough that every walk is a few minutes.
const HERE: Record<string, { lat: number; lng: number }> = {
  [ASHAR]: { lat: 33.7531, lng: -84.3853 },
  [ASHWANI]: { lat: 33.7549, lng: -84.3878 },
  [PRINCY]: { lat: 33.7508, lng: -84.3902 },
};
const PLACES: Place[] = [
  { name: "Queen Tea", lat: 33.7535, lng: -84.3869, walkMin: 3 },
  { name: "India Eats", lat: 33.7541, lng: -84.3881, walkMin: 4 },
  { name: "Mr. Fries Man", lat: 33.7519, lng: -84.3866, walkMin: 5 },
];

function world(opts: { places?: Place[]; locs?: Record<string, { lat: number; lng: number }> } = {}) {
  let n = 0;
  const w = {
    clock: AFTERNOON,
    texts: [] as { phone: string; text: string }[],
    polls: [] as (PollRecord & { phone: string })[],
    answers: new Map<string, string[]>(),
    locs: { ...(opts.locs ?? HERE) } as Record<string, { lat: number; lng: number }>,
    locRequests: [] as string[],
    originsSeen: [] as { lat: number; lng: number }[][],
    mealsSeen: [] as string[],
    cards: [] as { phone: string; card: MeetupCard }[],
    deps: undefined as unknown as PlanDeps,
    /** The person taps `label` on their latest poll whose title matches. */
    tap(phone: string, titleStart: string, optionLabel: string) {
      const rec = [...w.polls].reverse().find((p) => p.phone === phone && p.title.startsWith(titleStart));
      assert.ok(rec, `no "${titleStart}" poll sent to ${phone}`);
      const opt = rec.options.find((o) => o.label.startsWith(optionLabel));
      assert.ok(opt, `no option "${optionLabel}" in ${rec.options.map((o) => o.label).join(" | ")}`);
      // Polls that allow several picks keep every tap; a single-choice poll holds just one.
      const have = w.answers.get(rec.guid) ?? [];
      w.answers.set(rec.guid, rec.multi ? [...have.filter((v) => v !== opt.value), opt.value] : [opt.value]);
    },
    /** Take back a tap. */
    untap(phone: string, titleStart: string, optionLabel: string) {
      const rec = [...w.polls].reverse().find((p) => p.phone === phone && p.title.startsWith(titleStart))!;
      const opt = rec.options.find((o) => o.label.startsWith(optionLabel))!;
      w.answers.set(rec.guid, (w.answers.get(rec.guid) ?? []).filter((v) => v !== opt.value));
    },
    textsTo: (phone: string) => w.texts.filter((t) => t.phone === phone).map((t) => t.text),
    plan: async (id: string) => (await getState<Plan>(`plan#${id}`))!,
  };
  w.deps = {
    now: () => w.clock,
    sendText: async (phone, text) => (w.texts.push({ phone, text }), `any;-;${phone}`),
    openChat: async (phone) => `any;-;${phone}`,
    polls: {
      send: async (chatGuid: string, spec: PollSpec) => {
        const rec = { ...spec, guid: `g${n++}`, chatGuid, optionIds: Object.fromEntries(spec.options.map((o, i) => [`o${i}`, o.value])) };
        w.polls.push({ ...rec, phone: chatGuid.replace("any;-;", "") });
        return rec;
      },
      read: async (rec) => w.answers.get(rec.guid) ?? [],
    },
    location: {
      peek: async (phone) => w.locs[phone],
      request: async (_chat, phone) => void w.locRequests.push(phone),
    },
    sendCard: async (phone, card) => void w.cards.push({ phone, card }),
    users: async () => [
      { firstName: "Ashar", lastName: "M", phoneNumber: ASHAR },
      { firstName: "Ashwani", lastName: "M", phoneNumber: ASHWANI },
      { firstName: "Princy", lastName: "M", phoneNumber: PRINCY },
    ],
    places: async (_r, origins, meal) => (w.originsSeen.push(origins), w.mealsSeen.push(meal), opts.places ?? PLACES),
    organizerOrigin: async () => undefined,
    restrictionsFor: async () => ({ allergies: [], diets: [] }),
    interpret: async (_q, options, text) => options.findIndex((o) => o.toLowerCase().includes(text.toLowerCase())),
  };
  return w;
}
const start = (w: ReturnType<typeof world>, people = ["ashwani", "princy"], extra = {}) =>
  startPlan(w.deps, { phone: ASHAR, chatGuid: `any;-;${ASHAR}` }, { meal: "dinner", day: "today", people, anytime: true, ...extra });

/** Let the engine look, give people time to stop tapping, and look again (multi-pick polls count once things settle). */
const go = async (w: ReturnType<typeof world>, id: string) => {
  await advance(await w.plan(id), w.deps);
  w.clock += 16_000;
  await advance(await w.plan(id), w.deps);
};
const tick = async (w: ReturnType<typeof world>) => {
  await tickPlans(w.deps);
  w.clock += 16_000;
  await tickPlans(w.deps);
};

test("times: half-hour slots, only ones still ahead, and 12-hour labels", () => {
  assert.deepEqual(slotsFor("dinner", "today", AFTERNOON), ["17:30", "18:00", "18:30", "19:00", "19:30", "20:00", "20:30"]);
  assert.equal(minutesNow(AFTERNOON, "America/New_York"), 15 * 60);
  const sixThirty = Date.UTC(2026, 9, 10, 22, 30); // 6:30 PM in New York
  assert.deepEqual(slotsFor("dinner", "today", sixThirty), ["19:00", "19:30", "20:00", "20:30"]); // 30 minutes' notice: 7:00 is the first
  assert.deepEqual(slotsFor("dinner", "today", AFTERNOON, { earliestHour: 19 }), ["19:00", "19:30", "20:00", "20:30"]);
  assert.equal(slotsFor("dinner", "today", Date.UTC(2026, 9, 11, 1, 30)).length, 0); // 9:30 PM: too late for dinner
  assert.equal(slotsFor("dinner", "tomorrow", Date.UTC(2026, 9, 11, 1, 30)).length, 7);
  assert.equal(label("18:30"), "6:30 PM");
  assert.equal(label("07:30"), "7:30 AM");
  assert.equal(label("12:00"), "12:00 PM");
});

test("the proposed time is the lower median; the place is the most votes, ties to the nearest", () => {
  assert.deepEqual(proposeTime([3, 3]), { index: 3, unanimous: true });
  assert.deepEqual(proposeTime([2, 4]), { index: 2, unanimous: false });
  assert.deepEqual(proposeTime([1, 5, 3]), { index: 3, unanimous: false });
  assert.equal(winner(["A", "B", "C"], ["B", "C", "B"]), "B");
  assert.equal(winner(["A", "B", "C"], ["C", "B"]), "B"); // tie: B is listed before C
  assert.equal(winner(["A", "B"], []), undefined);
});


test("everyone picks the same time and place: one message at a time, then both get the details and the organizer is told", async () => {
  const w = world();
  const out = (await start(w)) as { planId: string; texting: string[] };
  assert.deepEqual(out.texting, ["Ashwani", "Princy"]);
  // Each friend gets ONE message: the time poll, which says who's asking. No separate texts.
  assert.deepEqual(w.textsTo(ASHWANI), []);
  assert.deepEqual(w.textsTo(PRINCY), []);
  assert.deepEqual(w.polls.filter((p) => p.phone === ASHWANI).map((p) => p.title.split("?")[0]), ["what time works for dinner today"]);
  assert.match(w.polls.find((p) => p.phone === ASHWANI)!.title, /Ashar is asking, with you and Princy/);
  assert.match(w.polls.find((p) => p.phone === PRINCY)!.title, /with you and Ashwani/);
  // The organizer already named a time (anytime), so their first message is the place poll.
  assert.equal(w.polls.filter((p) => p.phone === ASHAR && p.title.startsWith("where to eat?")).length, 1);

  w.tap(ASHWANI, "what time", "7:00 PM");
  w.tap(PRINCY, "what time", "7:00 PM");
  await go(w, out.planId);
  // Only after answering does each friend get the next message: the place poll.
  assert.deepEqual(w.polls.filter((p) => p.phone === ASHWANI).map((p) => p.title.split("?")[0]), ["what time works for dinner today", "where to eat"]);
  w.tap(ASHWANI, "where", "Queen Tea");
  w.tap(PRINCY, "where", "India Eats");
  w.tap(PRINCY, "where", "Queen Tea");
  w.tap(ASHAR, "where", "Queen Tea");
  await go(w, out.planId);

  assert.match(w.textsTo(ASHWANI).at(-1)!, /locked in: dinner at Queen Tea, 7:00 PM today\. Ashar and Princy will be there/);
  assert.match(w.textsTo(PRINCY).at(-1)!, /locked in: dinner at Queen Tea.*Ashar and Ashwani will be there/);
  assert.match(w.textsTo(ASHAR).at(-1)!, /dinner's set: Queen Tea at 7:00 PM today\. Ashwani and Princy are in/);
  assert.equal((await w.plan(out.planId)).stage, "done");
});


test("different times: the others are asked to move (once their other question is answered), and a no drops them", async () => {
  const w = world();
  const { planId } = (await start(w)) as { planId: string };
  w.tap(ASHWANI, "what time", "6:30 PM");
  w.tap(PRINCY, "what time", "7:30 PM");
  await go(w, planId);
  // Princy still has the place poll open, so the "would 6:30 work?" waits: one question at a time.
  assert.equal(w.polls.filter((p) => p.title.startsWith("does 6:30 PM work?")).length, 0);
  w.tap(PRINCY, "where", "India Eats");
  await go(w, planId);
  const ask = w.polls.filter((p) => p.title.startsWith("does 6:30 PM work?"));
  assert.equal(ask.length, 1);
  assert.equal(ask[0]!.phone, PRINCY); // 6:30 is the proposal; only Princy (who picked 7:30) is asked
  assert.match(ask[0]!.title, /to get everyone on the same time/);

  w.tap(PRINCY, "does 6:30", "nah");
  w.tap(ASHWANI, "where", "India Eats");
  w.tap(ASHAR, "where", "India Eats");
  await go(w, planId);
  const told = w.textsTo(ASHAR).at(-1)!;
  assert.match(told, /India Eats at 6:30 PM today\. Ashwani is in/);
  assert.match(told, /Princy couldn't do 6:30 PM/);
});


test("a yes to the proposal keeps everyone in", async () => {
  const w = world();
  const { planId } = (await start(w)) as { planId: string };
  w.tap(ASHWANI, "what time", "6:30 PM");
  w.tap(PRINCY, "what time", "7:30 PM");
  await go(w, planId);
  w.tap(PRINCY, "where", "Queen Tea");
  w.tap(ASHWANI, "where", "Queen Tea");
  w.tap(ASHAR, "where", "Queen Tea");
  await go(w, planId);
  w.tap(PRINCY, "does 6:30", "yeah");
  await go(w, planId);
  assert.match(w.textsTo(ASHAR).at(-1)!, /Queen Tea at 6:30 PM today\. Ashwani and Princy are in/);
});


test("someone can't make it and has no other time either: the rest carry on and the organizer is told", async () => {
  const w = world();
  const { planId } = (await start(w)) as { planId: string };
  w.tap(ASHWANI, "what time", "can't make it");
  w.tap(PRINCY, "what time", "8:00 PM");
  await go(w, planId);
  w.tap(ASHWANI, "what other time", "none of these");
  w.tap(PRINCY, "where", "Mr. Fries");
  w.tap(ASHAR, "where", "Mr. Fries");
  await go(w, planId);
  const told = w.textsTo(ASHAR).at(-1)!;
  assert.match(told, /Mr\. Fries Man at 8:00 PM today\. Princy is in/);
  assert.match(told, /Ashwani can't make it/);
});

test("everyone says they can't make it: the organizer hears that, nothing else is sent", async () => {
  const w = world();
  const { planId } = (await start(w)) as { planId: string };
  w.tap(ASHWANI, "what time", "can't make it");
  w.tap(PRINCY, "what time", "can't make it");
  await go(w, planId);
  w.tap(ASHWANI, "what other time", "none of these");
  w.tap(PRINCY, "what other time", "none of these");
  await go(w, planId);
  assert.match(w.textsTo(ASHAR).at(-1)!, /couldn't get dinner sorted: nobody can do dinner today/);
  assert.equal((await w.plan(planId)).stage, "failed");
});


test("quiet people are not nagged: no reminder texts, they're dropped after 5 minutes, and the rest go ahead", async () => {
  const w = world();
  const { planId } = (await start(w)) as { planId: string };
  w.tap(ASHWANI, "what time", "7:00 PM"); // Princy never answers
  await go(w, planId); // Ashwani's pick settles and his place poll goes out
  w.tap(ASHWANI, "where", "Queen Tea");
  w.tap(ASHAR, "where", "Queen Tea");
  await go(w, planId);
  w.clock += 3 * 60_000;
  await advance(await w.plan(planId), w.deps);
  assert.deepEqual(w.textsTo(PRINCY), []); // one message (the poll) and then quiet
  w.clock += 3 * 60_000; // past the 5 minutes everyone gets to answer
  await go(w, planId);
  assert.match(w.textsTo(ASHAR).at(-1)!, /Queen Tea at 7:00 PM today\. Ashwani is in\n\nPrincy didn't answer/);
});


test("a typed answer counts like a tap, and the next message is the place poll, not a 'hang tight'", async () => {
  const w = world();
  const { planId } = (await start(w)) as { planId: string };
  assert.equal(await handleReply(w.deps, ASHWANI, "7:00"), true);
  assert.ok(w.polls.some((p) => p.phone === ASHWANI && p.title.startsWith("where to eat?")), "their next message is the place poll");
  assert.equal(w.textsTo(ASHWANI).filter((t) => /hang tight/.test(t)).length, 0);
  // Not an answer: the normal chat handles it.
  assert.equal(await handleReply(w.deps, PRINCY, "lol what's the weather"), false);
  assert.equal(await handleReply(w.deps, ASHAR, "7:00"), false); // the organizer isn't being asked a time
  assert.equal(await handleReply(w.deps, "+19999999999", "7:00"), false); // nor a stranger
  assert.equal((await w.plan(planId)).people.find((p) => p.name === "ashwani")!.time!.answer, "19:00");
});

test("names must match a registered person; an unknown or ambiguous name is reported, not guessed", async () => {
  const w = world();
  const out = (await start(w, ["bob"])) as { error?: string; not_found: string[] };
  assert.equal(out.error, "nobody to plan with");
  assert.deepEqual(out.not_found, ["bob"]);
  const partial = (await start(w, ["ashwani", "bob"])) as { started?: boolean; texting: string[]; not_found: string[] };
  assert.equal(partial.started, true);
  assert.deepEqual(partial.texting, ["Ashwani"]);
  assert.deepEqual(partial.not_found, ["bob"]);
  const self = (await start(w, ["ashar"])) as { error?: string };
  assert.equal(self.error, "nobody to plan with"); // you can't plan a dinner with only yourself
});

test("too late for dinner today is said plainly", async () => {
  const w = world();
  w.clock = Date.UTC(2026, 9, 11, 1, 30); // 9:30 PM
  const out = (await start(w)) as { error?: string };
  assert.match(out.error!, /too late for dinner today/);
  assert.equal(w.texts.length, 0); // nobody is bothered
});

test("no place fits everyone's restrictions: the organizer is told", async () => {
  const w = world({ places: [] });
  const { planId } = (await start(w)) as { planId: string };
  w.tap(ASHWANI, "what time", "7:00 PM");
  w.tap(PRINCY, "what time", "7:00 PM");
  await go(w, planId);
  assert.match(w.textsTo(ASHAR).at(-1)!, /nothing nearby fits everyone's food restrictions/);
});


test("the minute-by-minute check moves plans along and ignores finished ones", async () => {
  await putState("plans#active", [], 60); // earlier tests leave plans open in the shared in-memory store
  const w = world();
  const { planId } = (await start(w)) as { planId: string };
  w.tap(ASHWANI, "what time", "7:00 PM");
  w.tap(PRINCY, "what time", "7:00 PM");
  await tick(w);
  assert.equal(w.polls.filter((p) => p.title.startsWith("where to eat?")).length, 3);
  w.tap(ASHWANI, "where", "Queen Tea");
  w.tap(PRINCY, "where", "Queen Tea");
  w.tap(ASHAR, "where", "Queen Tea");
  await tick(w);
  const sentAfterDone = w.texts.length;
  await tickPlans(w.deps); // a finished plan is no longer ticked
  assert.equal(w.texts.length, sentAfterDone);
  assert.equal((await w.plan(planId)).stage, "done");
});

test("someone asked to move who never answers their place poll is dropped, and the plan still finishes", async () => {
  const w = world();
  const { planId } = (await start(w)) as { planId: string };
  w.tap(ASHWANI, "what time", "6:30 PM");
  w.tap(PRINCY, "what time", "7:30 PM");
  await go(w, planId); // Princy has to be asked about 6:30, but her place poll is open and she never answers it
  w.tap(ASHWANI, "where", "India Eats");
  w.tap(ASHAR, "where", "India Eats");
  await go(w, planId);
  assert.equal((await w.plan(planId)).stage, "confirm");
  w.clock += 6 * 60_000; // past the 5 minutes everyone gets to answer
  await go(w, planId);
  assert.equal((await w.plan(planId)).stage, "done");
  const told = w.textsTo(ASHAR).at(-1)!;
  assert.match(told, /India Eats at 6:30 PM today\. Ashwani is in/);
  assert.match(told, /Princy didn't answer/);
  assert.equal(w.polls.filter((p) => p.title.startsWith("does 6:30 PM work?")).length, 0);
});

test("an organizer who has to confirm a moved time but never answers their place poll doesn't hold the plan forever", async () => {
  const w = world();
  const { planId } = (await start(w, ["ashwani", "princy"], { anytime: false, time: "7" })) as { planId: string };
  w.tap(ASHWANI, "what time", "8:00 PM");
  w.tap(PRINCY, "what time", "8:00 PM");
  await go(w, planId);
  w.tap(ASHWANI, "where", "Queen Tea");
  w.tap(PRINCY, "where", "Queen Tea");
  await go(w, planId);
  // Ashar asked for 7 and the others can only do 8, so he has to be asked. His place poll is still open.
  assert.equal((await w.plan(planId)).stage, "confirm");
  assert.equal(w.polls.filter((p) => p.title.startsWith("does 8:00 PM work?")).length, 0);
  w.clock += 6 * 60_000; // his place poll runs out of time, so the question about 8:00 can go out
  await go(w, planId);
  assert.equal(w.polls.filter((p) => p.phone === ASHAR && p.title.startsWith("does 8:00 PM work?")).length, 1);
  w.clock += 6 * 60_000; // and that one runs out too
  await go(w, planId);
  assert.equal((await w.plan(planId)).stage, "done");
  assert.match(w.textsTo(ASHAR).at(-1)!, /Queen Tea at 8:00 PM today/);
});

test("a plan that can never finish is dropped after three hours, so the every-minute check stops working on it", async () => {
  await putState("plans#active", [], 60);
  const w = world();
  const { planId } = (await start(w)) as { planId: string };
  w.tap(ASHWANI, "what time", "7:00 PM");
  w.tap(PRINCY, "what time", "7:00 PM");
  await tick(w);
  for (const who of [ASHWANI, PRINCY, ASHAR]) w.tap(who, "where", "Queen Tea");
  w.deps.places = async () => { throw new Error("database is down"); }; // the last check before choosing can never pass
  await tick(w);
  assert.equal((await w.plan(planId)).stage, "place");
  assert.deepEqual(await getState("plans#active"), [planId]);
  w.clock += 180 * 60_000;
  await tickPlans(w.deps);
  assert.deepEqual(await getState("plans#active"), []);
  assert.equal((await w.plan(planId)).stage, "failed");
  assert.match(w.textsTo(ASHAR).at(-1)!, /couldn't get dinner sorted: ran out of time/);
});

test("a plan that is over but still on the active list is taken off it instead of being checked every minute", async () => {
  await putState("plans#active", [], 60);
  const w = world();
  const { planId } = (await start(w)) as { planId: string };
  await putState(`plan#${planId}`, { ...(await w.plan(planId)), stage: "failed" }, 60);
  await tickPlans(w.deps);
  assert.deepEqual(await getState("plans#active"), []);
});

test("chooseTime: the time the most people ticked, ties to the middle of everything picked", () => {
  const slots = ["17:30", "18:00", "18:30", "19:00", "19:30"];
  assert.deepEqual(chooseTime(slots, [["18:30", "19:00"], ["19:00"]]), { index: 3, everyone: true });
  assert.deepEqual(chooseTime(slots, [["17:30"], ["19:30"]]), { index: 0, everyone: false }); // nobody overlaps: the earlier of the two
  const split = chooseTime(slots, [["17:30", "18:00"], ["18:00"], ["19:30"]]);
  assert.deepEqual(split, { index: 1, everyone: false }); // 6:00 suits two of three
});

test("several picks: nothing is said per tap, the best shared time wins without asking anyone to move", async () => {
  const w = world();
  const { planId } = (await start(w)) as { planId: string };
  const before = w.texts.length;
  w.tap(ASHWANI, "what time", "6:30 PM");
  await advance(await w.plan(planId), w.deps);
  w.tap(ASHWANI, "what time", "7:00 PM");
  await advance(await w.plan(planId), w.deps);
  w.tap(ASHWANI, "what time", "7:30 PM");
  await advance(await w.plan(planId), w.deps);
  assert.equal(w.texts.length, before, "taps are not answered one by one");
  assert.equal(w.polls.filter((p) => p.title === "does 7:00 PM work?").length, 0);
  assert.ok(w.polls.filter((p) => p.title.startsWith("what time")).every((p) => p.plan && p.multi), "time polls are owned by the plan and allow several picks");

  w.tap(PRINCY, "what time", "7:00 PM");
  await go(w, planId);
  const plan = await w.plan(planId);
  assert.equal(plan.timeChoice, "19:00"); // the one time both ticked
  assert.equal(w.polls.filter((p) => p.title.startsWith("does ")).length, 0); // nobody has to move
  assert.deepEqual(plan.people.find((p) => p.name === "ashwani")!.time!.picks, ["18:30", "19:00", "19:30"]);
});

test("once a tap settles they get one acknowledgement naming what they picked, not one per tap", async () => {
  const w = world();
  const { planId } = (await start(w)) as { planId: string };
  w.tap(ASHWANI, "what time", "6:30 PM");
  await advance(await w.plan(planId), w.deps);
  w.tap(ASHWANI, "what time", "7:00 PM");
  await advance(await w.plan(planId), w.deps);
  assert.equal(w.textsTo(ASHWANI).filter((t) => /6:30|7:00/.test(t)).length, 0, "nothing while they're still tapping");
  await go(w, planId);
  const acks = w.textsTo(ASHWANI).filter((t) => /6:30 PM.*7:00 PM/.test(t));
  assert.equal(acks.length, 1);
});

test("changing your mind restarts the wait; the answer counts only once you stop tapping", async () => {
  const w = world();
  const { planId } = (await start(w)) as { planId: string };
  const ashwani = async () => (await w.plan(planId)).people.find((p) => p.name === "ashwani")!.time!;
  w.tap(ASHWANI, "what time", "6:30 PM");
  await advance(await w.plan(planId), w.deps);
  w.clock += 10_000;
  w.untap(ASHWANI, "what time", "6:30 PM");
  w.tap(ASHWANI, "what time", "8:00 PM");
  await advance(await w.plan(planId), w.deps);
  w.clock += 1_500; // 1.5s since the change: still open (a tap counts after 3s of quiet)
  await advance(await w.plan(planId), w.deps);
  assert.equal((await ashwani()).answer, undefined);
  w.clock += 2_000;
  await advance(await w.plan(planId), w.deps);
  assert.deepEqual((await ashwani()).picks, ["20:00"]);
});


test("whoever finishes first is told to hang tight, once, while the others are checked", async () => {
  const w = world();
  const { planId } = (await start(w)) as { planId: string };
  w.tap(ASHWANI, "what time", "7:00 PM");
  await go(w, planId);
  assert.equal(w.textsTo(ASHWANI).filter((t) => /hang tight/.test(t)).length, 0); // he still has the place poll to answer
  w.tap(ASHWANI, "where", "Queen Tea");
  await go(w, planId);
  await go(w, planId);
  assert.equal(w.textsTo(ASHWANI).filter((t) => /hang tight/.test(t)).length, 1);
  assert.equal(w.textsTo(PRINCY).filter((t) => /hang tight/.test(t)).length, 0); // she hasn't answered yet
});


test("locations: after the time answer a friend not sharing gets ONE message (the location request), then the place poll", async () => {
  const w = world({ locs: { [ASHAR]: HERE[ASHAR]! } });
  const { planId } = (await start(w)) as { planId: string };
  assert.deepEqual(w.locRequests, []); // nobody is asked for a location along with the time poll
  w.tap(ASHWANI, "what time", "7:00 PM");
  w.tap(PRINCY, "what time", "7:00 PM");
  await go(w, planId);
  assert.deepEqual([...w.locRequests].sort(), [ASHWANI, PRINCY]);
  assert.deepEqual(w.textsTo(ASHWANI).filter((t) => !/7:00 PM/.test(t)), []); // the location request is a card, not a text (only the "got it" for their pick)
  assert.ok(!w.polls.some((p) => p.phone === ASHWANI && p.title.startsWith("where to eat?")), "waits for them to share");
  w.locs[ASHWANI] = HERE[ASHWANI]!; // Ashwani shares
  await go(w, planId);
  assert.ok(w.polls.some((p) => p.phone === ASHWANI && p.title.startsWith("where to eat?")));
  assert.ok(!w.polls.some((p) => p.phone === PRINCY && p.title.startsWith("where to eat?")), "Princy hasn't shared yet");
  w.clock += 46_000; // after 45 seconds it goes with whoever shared
  await advance(await w.plan(planId), w.deps);
  assert.ok(w.polls.some((p) => p.phone === PRINCY && p.title.startsWith("where to eat?")));
});


test("locations: people already sharing skip the request and see their own walk times", async () => {
  const w = world();
  const { planId } = (await start(w)) as { planId: string };
  w.tap(ASHWANI, "what time", "7:00 PM");
  w.tap(PRINCY, "what time", "7:00 PM");
  await go(w, planId);
  assert.deepEqual(w.locRequests, []);
  const poll = w.polls.find((p) => p.phone === ASHWANI && p.title.startsWith("where to eat?"))!;
  assert.match(poll.options[0]!.label, /^Queen Tea · \d+ min$/);
});

test("several places can be ticked; the most-ticked wins, and everyone gets the card with place, time and people", async () => {
  const w = world();
  const { planId } = (await start(w)) as { planId: string };
  w.tap(ASHWANI, "what time", "7:00 PM");
  w.tap(PRINCY, "what time", "7:00 PM");
  await go(w, planId);
  const placesBefore = w.texts.length;
  w.tap(ASHWANI, "where", "Queen Tea");
  w.tap(ASHWANI, "where", "India Eats");
  w.tap(PRINCY, "where", "India Eats");
  w.tap(ASHAR, "where", "India Eats");
  await advance(await w.plan(planId), w.deps);
  assert.equal(w.texts.length, placesBefore, "no reply per tapped place");
  await go(w, planId);

  assert.match(w.textsTo(ASHAR).at(-1)!, /dinner's set: India Eats at 7:00 PM today/);
  assert.deepEqual(w.cards.map((c) => c.phone).sort(), [ASHAR, ASHWANI, PRINCY].sort());
  const card = w.cards[0]!.card;
  assert.equal(card.place, "India Eats");
  assert.equal(card.time, "7:00 PM");
  assert.equal(card.date, "Saturday, Oct 10");
  assert.deepEqual(card.people.map((p) => p.name), ["ashar", "ashwani", "princy"]);
  assert.ok(card.people.every((p) => (p.walkMin ?? 0) >= 1), "everyone's walk is shown");
  assert.match(card.note!, /farthest walk \d+ min/);
});

test("the plan card is a real JPEG", async () => {
  const jpeg = await meetupJpeg({
    meal: "dinner",
    place: "Mr. Fries Man",
    time: "7:00 PM",
    date: "Saturday, Oct 10",
    people: [{ name: "ashar", walkMin: 4 }, { name: "ashwani", walkMin: 6 }, { name: "princy" }],
    note: "closest spot that works for everyone · farthest walk 6 min",
  });
  assert.equal(jpeg[0], 0xff);
  assert.equal(jpeg[1], 0xd8);
  assert.ok(jpeg.length > 5000);
});

// ---------- the organizer is asked first, shared context, decline flow ----------

const startNoTime = (w: ReturnType<typeof world>, extra = {}) =>
  startPlan(w.deps, { phone: ASHAR, chatGuid: `any;-;${ASHAR}` }, { meal: "dinner", day: "today", people: ["ashwani", "princy"], ...extra });

test("parseTimeAnswer: bare hours follow the meal, and anytime is its own answer", () => {
  assert.deepEqual(parseTimeAnswer("7", "dinner"), { hhmm: "19:00" });
  assert.deepEqual(parseTimeAnswer("around 7:30pm", "dinner"), { hhmm: "19:30" });
  assert.deepEqual(parseTimeAnswer("noon", "lunch"), { hhmm: "12:00" });
  assert.deepEqual(parseTimeAnswer("11", "lunch"), { hhmm: "11:00" });
  assert.deepEqual(parseTimeAnswer("2", "lunch"), { hhmm: "14:00" });
  assert.deepEqual(parseTimeAnswer("8:15", "breakfast"), { hhmm: "08:15" });
  assert.deepEqual(parseTimeAnswer("Anytime is good", "dinner"), { anytime: true });
  assert.equal(parseTimeAnswer("banana", "dinner"), undefined);
  assert.equal(parseTimeAnswer("25", "dinner"), undefined);
});

test("slots around a time include it, and alternates sit outside the first options", () => {
  const first = slotsAround("19:00", "today", AFTERNOON);
  assert.deepEqual(first, ["18:00", "18:30", "19:00", "19:30", "20:00", "20:30"]);
  const alts = altSlotsFor({ meal: "dinner", day: "today", slots: first }, AFTERNOON);
  assert.ok(alts.length > 0 && alts.every((x) => !first.includes(x)));
  assert.ok(alts.includes("21:00") && alts.includes("17:00"));
});

test("asking for a plan with no time: the organizer is asked first and nobody else is texted yet", async () => {
  const w = world();
  const out = (await startNoTime(w)) as { asking_time?: boolean; planId: string; sent_text?: string };
  assert.equal(out.asking_time, true);
  assert.match(w.textsTo(ASHAR)[0]!, /what time/);
  assert.equal(w.textsTo(ASHWANI).length, 0);
  assert.equal(w.polls.length, 0);
  assert.equal((await w.plan(out.planId)).stage, "ask_time");
});


test("the organizer's answer starts the plan: friends get the time poll, and the organizer the place poll", async () => {
  const w = world();
  const out = (await startNoTime(w)) as { planId: string };
  assert.equal(await handleReply(w.deps, ASHAR, "7"), true);
  const times = w.polls.find((p) => p.phone === ASHWANI && p.title.startsWith("what time"))!;
  assert.match(times.title, /around 7:00 PM/);
  assert.ok(times.options.some((o) => o.label === "7:00 PM"));
  assert.deepEqual(w.textsTo(ASHWANI), []); // one message: the poll
  assert.equal(w.polls.filter((p) => p.title.startsWith("where to eat?")).length, 1); // the organizer's
  assert.equal((await w.plan(out.planId)).anchor, "19:00");
  // everyone else is asked about the place after their time answer; a different agreed time has to work for the organizer too
  w.tap(ASHWANI, "what time", "8:00 PM");
  w.tap(PRINCY, "what time", "8:00 PM");
  await go(w, out.planId);
  assert.equal(w.polls.filter((p) => p.title.startsWith("where to eat?")).length, 3);
  for (const who of [ASHAR, ASHWANI, PRINCY]) w.tap(who, "where", "Queen Tea");
  await go(w, out.planId);
  assert.ok(w.polls.some((p) => p.phone === ASHAR && p.title.startsWith("does 8:00 PM work?")));
});

test("anytime skips the question, and a non-answer is asked again", async () => {
  const w = world();
  const out = (await startNoTime(w, { anytime: true })) as { asking_time?: boolean };
  assert.equal(out.asking_time, undefined);
  assert.ok(w.polls.length > 0);
  const w2 = world();
  await startNoTime(w2);
  assert.equal(await handleReply(w2.deps, ASHAR, "umm not sure"), true);
  assert.match(w2.textsTo(ASHAR).at(-1)!, /didn't catch that/);
  assert.equal(await handleReply(w2.deps, ASHAR, "anytime"), true);
  assert.ok(w2.polls.some((p) => p.phone === ASHWANI));
  assert.equal(await handleReply(w2.deps, ASHWANI, "7:00"), true); // now a typed answer to Ashwani's time poll
});

test("cancelling while being asked for a time drops the plan", async () => {
  const w = world();
  const { planId } = (await startNoTime(w)) as { planId: string };
  assert.equal(await handleReply(w.deps, ASHAR, "nvm"), true);
  assert.equal((await w.plan(planId)).stage, "failed");
  assert.equal(w.polls.length, 0);
});

test("shared context lasts 5 minutes: after that typed replies are ordinary chat and the note is gone", async () => {
  const w = world();
  const { planId } = (await start(w)) as { planId: string };
  const note = await planNoteFor(ASHWANI, w.clock + 60_000);
  assert.match(note!, /Ashar asked to plan dinner today with Ashwani and Princy/);
  assert.doesNotMatch(note!, /allerg|diet|vegan|halal/i); // logistics only
  w.clock += 5 * 60_000 + 1000;
  assert.equal(await planNoteFor(ASHWANI, w.clock), undefined);
  assert.equal(await handleReply(w.deps, ASHWANI, "7:00"), false);
  assert.equal((await w.plan(planId)).people[0]!.time!.answer, undefined);
});

test("an organizer who never answers the time question: the plan lapses after 5 minutes with one polite text", async () => {
  const w = world();
  const { planId } = (await startNoTime(w)) as { planId: string };
  w.clock += 5 * 60_000 + 1000;
  await advance(await w.plan(planId), w.deps);
  assert.match(w.textsTo(ASHAR).at(-1)!, /no worries, just tell me when you want to plan dinner/);
  assert.equal((await w.plan(planId)).stage, "failed");
  assert.equal(await handleReply(w.deps, ASHAR, "7"), false);
});


test("someone can't make it: one message with the sorry and a poll of other times, then the gang is asked to move", async () => {
  const w = world();
  const { planId } = (await start(w)) as { planId: string };
  w.tap(ASHWANI, "what time", "can't make it");
  w.tap(PRINCY, "what time", "6:00 PM");
  await go(w, planId);
  assert.deepEqual(w.textsTo(ASHWANI), []); // the apology is inside the poll, not a second message
  const alt = w.polls.find((p) => p.phone === ASHWANI && p.title.startsWith("what other time"))!;
  assert.match(alt.title, /sorry you can't make it\. i'll ask the gang if they could move the slot|aw sorry about that\. i'll ask the gang if they could move the slot/);
  assert.ok(alt.multi && alt.options.some((o) => o.label === "9:00 PM") && alt.options.some((o) => o.value === "none"));
  assert.ok(!alt.options.some((o) => o.label === "6:00 PM"), "only times outside the first options");
  assert.equal(w.polls.filter((p) => p.title.startsWith("does ")).length, 0, "nobody is asked to move until they've said what works");

  w.tap(ASHWANI, "what other time", "9:00 PM");
  w.tap(PRINCY, "where", "Queen Tea");
  await go(w, planId);
  // Princy has answered everything else, so now she is asked to move, and told why
  const ask = w.polls.find((p) => p.phone === PRINCY && p.title.startsWith("does 9:00 PM work?"))!;
  assert.ok(ask);
  assert.match(ask.title, /Ashwani can't make the earlier times/);
  assert.equal(w.polls.filter((p) => p.phone === ASHWANI && p.title.startsWith("does ")).length, 0);

  w.tap(PRINCY, "does 9:00", "yeah");
  w.tap(ASHWANI, "where", "Queen Tea");
  w.tap(ASHAR, "where", "Queen Tea");
  await go(w, planId);
  assert.match(w.textsTo(ASHAR).at(-1)!, /Queen Tea at 9:00 PM today\. Ashwani and Princy are in/);
});


test("the gang says no to moving: only the people who could do the new time stay in", async () => {
  const w = world();
  const { planId } = (await start(w)) as { planId: string };
  w.tap(ASHWANI, "what time", "can't make it");
  w.tap(PRINCY, "what time", "6:00 PM");
  await go(w, planId);
  w.tap(ASHWANI, "what other time", "9:00 PM");
  w.tap(PRINCY, "where", "India Eats");
  await go(w, planId);
  w.tap(PRINCY, "does 9:00", "nah");
  w.tap(ASHWANI, "where", "India Eats");
  w.tap(ASHAR, "where", "India Eats");
  await go(w, planId);
  const told = w.textsTo(ASHAR).at(-1)!;
  assert.match(told, /India Eats at 9:00 PM today\. Ashwani is in/);
  assert.match(told, /Princy couldn't do 9:00 PM/);
});


test("a place that stops fitting before the end is dropped from the choice", async () => {
  const w = world();
  const { planId } = (await start(w)) as { planId: string };
  for (const who of [ASHWANI, PRINCY]) w.tap(who, "what time", "7:00 PM");
  await go(w, planId);
  for (const who of [ASHAR, ASHWANI, PRINCY]) w.tap(who, "where", "Queen Tea");
  // someone texts an allergy after the polls went out: only India Eats still fits
  w.deps.places = async () => [PLACES[1]!];
  await go(w, planId);
  assert.match(w.textsTo(ASHAR).at(-1)!, /dinner's set: India Eats/);
});

test("names are matched against the saved profiles first, so 'Ash' is Ash and not Ashar", async () => {
  const w = world();
  w.deps.users = async () => [
    { firstName: "Ash", lastName: null, phoneNumber: "+17739986828" },
    { firstName: "Ashar", lastName: null, phoneNumber: ASHAR },
    { firstName: "Princy", lastName: null, phoneNumber: PRINCY },
  ];
  const out = (await startPlan(w.deps, { phone: ASHAR, chatGuid: `any;-;${ASHAR}` }, { meal: "lunch", day: "tomorrow", people: ["Ash", "princy"], anytime: true })) as { texting: string[]; ambiguous: string[] };
  assert.deepEqual(out.texting, ["Ash", "Princy"]);
  assert.deepEqual(out.ambiguous, []);
});

test("asking for a meal that's already over today says so first and texts nobody", async () => {
  const w = world();
  w.clock = Date.UTC(2026, 9, 10, 20, 10); // 4:10 PM: lunch is over
  const out = (await startPlan(w.deps, { phone: ASHAR, chatGuid: `any;-;${ASHAR}` }, { meal: "lunch", day: "today", people: ["ashwani", "princy"] })) as { error?: string };
  assert.match(out.error!, /too late for lunch today/);
  assert.equal(w.texts.length, 0);
  assert.equal(w.polls.length, 0);
  // dinner at the same moment is fine
  const dinner = (await startPlan(w.deps, { phone: ASHAR, chatGuid: `any;-;${ASHAR}` }, { meal: "dinner", day: "today", people: ["ashwani", "princy"] })) as { asking_time?: boolean };
  assert.equal(dinner.asking_time, true);
});

// ---------- place poll wording, "anywhere", and the card ----------


test("when restrictions cut the list, the poll says how many of the places fit without saying whose restrictions", async () => {
  const w = world();
  w.deps.places = async (r) => (r.diets.length > 0 || r.allergies.length > 0 ? PLACES.slice(0, 2) : PLACES);
  w.deps.restrictionsFor = async (g) => (g.endsWith(PRINCY) ? { allergies: [], diets: ["vegan"] } : { allergies: [], diets: [] });
  await start(w);
  const poll = w.polls.find((p) => p.phone === ASHAR && p.title.startsWith("where to eat?"))!;
  assert.equal(poll.options.length, 2);
  assert.match(poll.title, /2 of 3 spots work for everyone's food restrictions/);
  assert.doesNotMatch(poll.title, /vegan|princy/i);
});


test("with nothing limiting the list, all of them are offered and the poll says so", async () => {
  const w = world();
  await start(w);
  const poll = w.polls.find((p) => p.phone === ASHAR && p.title.startsWith("where to eat?"))!;
  assert.match(poll.title, /all 3 spots work for everyone's food restrictions/);
  assert.equal(poll.options.length, 3);
});

test("only one spot fits everyone: no poll (Photon needs two options), it is simply named at the end", async () => {
  const w = world({ places: [PLACES[1]!] });
  const { planId } = (await start(w)) as { planId: string };
  assert.equal(w.polls.filter((p) => p.title.startsWith("where to eat?")).length, 0);
  for (const who of [ASHWANI, PRINCY]) w.tap(who, "what time", "7:00 PM");
  await go(w, planId);
  assert.equal(w.polls.filter((p) => p.title.startsWith("where to eat?")).length, 0);
  assert.match(w.textsTo(ASHAR).at(-1)!, /dinner's set: India Eats at 7:00 PM today/);
  assert.equal((await w.plan(planId)).stage, "done");
});

test("if Photon can't create a poll, the question goes as one text with its options and typed replies work", async () => {
  const w = world();
  const realSend = w.deps.polls.send;
  w.deps.polls.send = async (g, spec) => {
    if (spec.title.startsWith("what time")) throw new Error("upstream down");
    return realSend(g, spec);
  };
  const { planId } = (await start(w)) as { planId: string };
  assert.equal(w.textsTo(ASHWANI).length, 1);
  assert.match(w.textsTo(ASHWANI)[0]!, /what time works for dinner today[\s\S]*7:00 PM/);
  assert.equal(await handleReply(w.deps, ASHWANI, "7:00"), true);
  assert.equal((await w.plan(planId)).people.find((p) => p.name === "ashwani")!.time!.answer, "19:00");
});

test("saying 'anywhere' on the place question ticks every spot for them", async () => {
  const w = world();
  const { planId } = (await start(w)) as { planId: string };
  assert.equal(await handleReply(w.deps, ASHWANI, "7:00"), true); // the time question comes first
  assert.equal(await handleReply(w.deps, ASHWANI, "anywhere is fine"), true);
  const plan = await w.plan(planId);
  assert.deepEqual(plan.people.find((p) => p.name === "ashwani")!.place!.picks, PLACES.map((x) => x.name));
  // not "anywhere" when it isn't about the place question: the model handles it as chat
  assert.equal(await handleReply(w.deps, PRINCY, "what's the weather"), false);
});

test("the plan card: the font files ship, long names wrap to two lines, and it renders", async () => {
  assert.ok(useBundledFonts(), "Inter must be found or card text turns into boxes on Lambda");
  assert.ok(existsSync("bot/assets/fonts/Inter-ExtraBold.ttf") && existsSync("bot/assets/fonts/OFL.txt"));
  assert.deepEqual(wrapName("Stir House Atlanta", 22), ["Stir House Atlanta"]);
  assert.deepEqual(wrapName("Mangos Caribbean Restaurant", 22), ["Mangos Caribbean", "Restaurant"]);
  const jpeg = await meetupJpeg({ meal: "dinner", place: "Mangos Caribbean Restaurant", time: "7:30 PM", date: "Saturday, Oct 10", people: [{ name: "ash" }, { name: "princy", walkMin: 4 }] });
  assert.ok(jpeg.length > 5000);
});

// ---------- pacing, instant votes, no coffee shops at dinner, card page ----------

test("paced: one person's sends keep at least the gap apart and stay in order; other people aren't held up", async () => {
  process.env.PLAN_PACE_MS = "120";
  const at: Record<string, number[]> = { a: [], b: [] };
  const order: string[] = [];
  const t0 = Date.now();
  await Promise.all([
    paced("a", async () => (at.a!.push(Date.now() - t0), order.push("a1"))),
    paced("a", async () => (at.a!.push(Date.now() - t0), order.push("a2"))),
    paced("a", async () => (at.a!.push(Date.now() - t0), order.push("a3"))),
    paced("b", async () => (at.b!.push(Date.now() - t0), order.push("b1"))),
  ]);
  delete process.env.PLAN_PACE_MS;
  assert.deepEqual(order.filter((x) => x.startsWith("a")), ["a1", "a2", "a3"]);
  assert.ok(at.a![1]! - at.a![0]! >= 100 && at.a![2]! - at.a![1]! >= 100, `gaps: ${at.a}`);
  assert.ok(at.b![0]! < 60, "a different person is texted right away");
});

test("plan polls are told apart from dish and restaurant polls by title", () => {
  for (const yes of ["what time works for dinner today?", "where to eat?", "does 7:30 PM work?", "what other time works for dinner today?"]) assert.ok(isPlanPollTitle(yes), yes);
  for (const no of ["what are you getting at Moe's?", "pick a spot", undefined]) assert.ok(!isPlanPollTitle(no as string), String(no));
});

test("a tap is counted within a few seconds by looking right away, not at the next minute check", async () => {
  const w = world();
  const { planId } = (await start(w)) as { planId: string };
  // Time moves 1.5s each time the engine looks, standing in for real seconds passing.
  w.deps.now = () => (w.clock += 1500);
  w.tap(ASHWANI, "what time", "7:00 PM");
  const t0 = Date.now();
  assert.equal(await onPlanVote(w.deps, ASHWANI, 15_000), true);
  assert.ok(Date.now() - t0 < 8000, "returns once the tap is counted");
  assert.equal((await w.plan(planId)).people.find((p) => p.name === "ashwani")!.time!.answer, "19:00");
  assert.equal(await onPlanVote(w.deps, "+19999999999"), false); // nobody else's plan
});

test("dinner places never include coffee shops or drink counters; the plan asks for dinner places", async () => {
  const { servesMeal, mealAt } = await import("../../src/data/cuisines.js");
  for (const id of ["starbucks", "saxbys", "queen-tea"]) {
    assert.equal(servesMeal(id, "dinner"), false, id);
    assert.equal(servesMeal(id, "lunch"), true, id);
    assert.equal(servesMeal(id, "breakfast"), true, id);
  }
  for (const id of ["stir-house", "india-eats", "moes", "mangos", "mr-fries-man", "strikeout-wingz"]) assert.equal(servesMeal(id, "dinner"), true, id);
  assert.equal(mealAt(9 * 60), "breakfast");
  assert.equal(mealAt(12 * 60), "lunch");
  assert.equal(mealAt(16 * 60 + 30), "dinner");
  const w = world();
  await start(w);
  assert.ok(w.mealsSeen.length > 0 && w.mealsSeen.every((m) => m === "dinner"));
});

test("the card page: link-preview tags, escaped names, and a token that can't be guessed or abused", async () => {
  const { cardPageHtml } = await import("../../bot/src/meetup-card.js");
  const { publishCard, loadCard, rememberBaseUrl, isCardToken } = await import("../../bot/src/cards.js");
  const card = { meal: "dinner", place: "Stir House <b>Atlanta</b>", time: "7:30 PM", date: "Saturday, Oct 10", people: [{ name: "ash", walkMin: 6 }, { name: "princy" }] };
  const html = cardPageHtml(card, "https://x.test/card/abc.jpg", "https://x.test/card/abc");
  assert.match(html, /og:title" content="Stir House &#60;b&#62;Atlanta&#60;\/b&#62; · 7:30 PM"/);
  assert.match(html, /og:description" content="Dinner, Saturday, Oct 10\. Going: Ash, Princy"/);
  assert.match(html, /og:image" content="https:\/\/x\.test\/card\/abc\.jpg"/);
  assert.doesNotMatch(html, /<b>Atlanta/);
  await rememberBaseUrl("abc123.lambda-url.us-east-2.on.aws");
  const url = (await publishCard(card))!;
  assert.match(url, /^https:\/\/abc123\.lambda-url\.us-east-2\.on\.aws\/card\/[A-Za-z0-9_-]{12}$/);
  assert.deepEqual(await loadCard(url.split("/").pop()!), card);
  assert.equal(await loadCard("../../etc/passwd"), undefined);
  assert.equal(isCardToken("short"), false);
});

test("app card art: clock hands sit on the meeting time, and the layout names the place, time and who's going", async () => {
  const { clockAngles, meetupLayout } = await import("../../bot/src/meetup-art.js");
  assert.deepEqual(clockAngles("7:30 PM"), { hour: 225, minute: 180 });
  assert.deepEqual(clockAngles("12:00 PM"), { hour: 0, minute: 0 });
  const card: MeetupCard = { meal: "dinner", place: "Stir House Atlanta", time: "7:30 PM", date: "Saturday, Oct 10", people: [{ name: "ash", walkMin: 6 }, { name: "princy", walkMin: 4 }] };
  const layout = await meetupLayout(card);
  assert.equal(layout.caption, "Stir House Atlanta");
  assert.equal(layout.subcaption, "7:30 PM · Ash, Princy");
  assert.equal(layout.trailingCaption, "2 going");
  assert.equal(layout.trailingSubcaption, "6 min walk");
  assert.equal(layout.imageTitle, "Dinner's on");
  assert.ok(layout.image.length > 10_000, "the picture rendered");
});
