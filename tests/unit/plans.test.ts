import assert from "node:assert/strict";
import test from "node:test";
import { type Place, type Plan, type PlanDeps, advance, chooseTime, handleReply, label, minutesNow, proposeTime, slotsFor, startPlan, tickPlans, winner } from "../../bot/src/plans.js";
import { getState, putState } from "../../bot/src/store.js";
import type { PollRecord, PollSpec } from "../../bot/src/polls.js";
import type { MeetupCard } from "../../bot/src/meetup-card.js";
import { meetupJpeg } from "../../bot/src/meetup-card.js";

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
    places: async (_r, origins) => (w.originsSeen.push(origins), opts.places ?? PLACES),
    organizerOrigin: async () => undefined,
    restrictionsFor: async () => ({ allergies: [], diets: [] }),
    interpret: async (_q, options, text) => options.findIndex((o) => o.toLowerCase().includes(text.toLowerCase())),
  };
  return w;
}
const start = (w: ReturnType<typeof world>, people = ["ashwani", "princy"], extra = {}) =>
  startPlan(w.deps, { phone: ASHAR, chatGuid: `any;-;${ASHAR}` }, { meal: "dinner", day: "today", people, ...extra });

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

test("everyone picks the same time and place: both get the details, then the organizer is told", async () => {
  const w = world();
  const out = (await start(w)) as { planId: string; texting: string[] };
  assert.deepEqual(out.texting, ["Ashwani", "Princy"]);
  // Each person is texted separately, with a time poll, and only they see their own message.
  assert.match(w.textsTo(ASHWANI)[0]!, /hey Ashwani, Ashar wants to do dinner today with you and Princy/);
  assert.match(w.textsTo(PRINCY)[0]!, /with you and Ashwani/);
  assert.equal(w.polls.filter((p) => p.title.startsWith("what time")).length, 2);
  assert.equal(w.textsTo(ASHAR).length, 0); // the organizer hears nothing until it's sorted

  w.tap(ASHWANI, "what time", "7:00 PM");
  w.tap(PRINCY, "what time", "7:00 PM");
  await go(w, out.planId);
  assert.equal(w.polls.filter((p) => p.title === "where to eat?").length, 2); // straight to the place poll
  assert.match(w.textsTo(ASHWANI).at(-1)!, /7:00 PM it is/);

  w.tap(ASHWANI, "where", "Queen Tea");
  w.tap(PRINCY, "where", "India Eats");
  w.tap(PRINCY, "where", "Queen Tea");
  await go(w, out.planId);

  assert.match(w.textsTo(ASHWANI).at(-1)!, /locked in: dinner at Queen Tea, 7:00 PM today\. Ashar and Princy will be there/);
  assert.match(w.textsTo(PRINCY).at(-1)!, /locked in: dinner at Queen Tea.*Ashar and Ashwani will be there/);
  assert.match(w.textsTo(ASHAR).at(-1)!, /dinner's set: Queen Tea at 7:00 PM today\. Ashwani and Princy are in/);
  assert.equal((await w.plan(out.planId)).stage, "done");
});

test("different times: the others are asked to move, and a no drops them, with the organizer told why", async () => {
  const w = world();
  const { planId } = (await start(w)) as { planId: string };
  w.tap(ASHWANI, "what time", "6:30 PM");
  w.tap(PRINCY, "what time", "7:30 PM");
  await go(w, planId);
  // 6:30 is the proposal; only Princy (who picked 7:30) is asked.
  assert.equal(w.polls.filter((p) => p.title === "does 6:30 PM work?").length, 1);
  assert.equal(w.polls.find((p) => p.title === "does 6:30 PM work?")!.phone, PRINCY);
  assert.match(w.textsTo(PRINCY).at(-1)!, /would 6:30 PM work for you instead/);

  w.tap(PRINCY, "does 6:30", "nah");
  await go(w, planId);
  assert.equal(w.polls.filter((p) => p.title === "where to eat?").length, 1); // only Ashwani is still in
  w.tap(ASHWANI, "where", "India Eats");
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
  w.tap(PRINCY, "does 6:30", "yeah");
  await go(w, planId);
  w.tap(ASHWANI, "where", "Queen Tea");
  w.tap(PRINCY, "where", "Queen Tea");
  await go(w, planId);
  assert.match(w.textsTo(ASHAR).at(-1)!, /Queen Tea at 6:30 PM today\. Ashwani and Princy are in/);
});

test("someone can't make it: the rest carry on and the organizer is told", async () => {
  const w = world();
  const { planId } = (await start(w)) as { planId: string };
  w.tap(ASHWANI, "what time", "can't make it");
  w.tap(PRINCY, "what time", "8:00 PM");
  await go(w, planId);
  w.tap(PRINCY, "where", "Mr. Fries");
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
  assert.match(w.textsTo(ASHAR).at(-1)!, /couldn't get dinner sorted: nobody can do dinner today/);
  assert.equal(w.polls.filter((p) => p.title === "where to eat?").length, 0);
  assert.equal((await w.plan(planId)).stage, "failed");
});

test("quiet people get one nudge, then are dropped; if nobody answers the organizer is told", async () => {
  const w = world();
  const { planId } = (await start(w)) as { planId: string };
  w.tap(ASHWANI, "what time", "7:00 PM"); // Princy never answers
  await go(w, planId); // Ashwani's pick settles
  w.clock += 11 * 60_000;
  await advance(await w.plan(planId), w.deps);
  assert.equal(w.textsTo(PRINCY).filter((t) => /poll/.test(t)).length, 1); // nudged
  assert.equal(w.textsTo(ASHWANI).filter((t) => /still need your pick|tap one on the poll/.test(t)).length, 0); // not Ashwani, who answered
  await advance(await w.plan(planId), w.deps);
  assert.equal(w.textsTo(PRINCY).filter((t) => /poll/.test(t)).length, 1); // only once
  w.clock += 40 * 60_000;
  await go(w, planId);
  assert.ok(w.polls.some((p) => p.phone === ASHWANI && p.title === "where to eat?"), "moves on without Princy");
  w.tap(ASHWANI, "where", "Queen Tea");
  await go(w, planId);
  assert.match(w.textsTo(ASHAR).at(-1)!, /Queen Tea at 7:00 PM today\. Ashwani is in\n\nPrincy didn't answer/);
});

test("a typed answer counts like a tap, and they're told when it isn't settled yet", async () => {
  const w = world();
  const { planId } = (await start(w)) as { planId: string };
  assert.equal(await handleReply(w.deps, ASHWANI, "7:00"), true);
  assert.match(w.textsTo(ASHWANI).at(-1)!, /hang tight/); // Princy hasn't answered yet
  // Not an answer: the normal chat handles it.
  assert.equal(await handleReply(w.deps, PRINCY, "lol what's the weather"), false);
  assert.equal(await handleReply(w.deps, ASHAR, "7:00"), false); // the organizer isn't being asked anything
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
  assert.equal(w.polls.filter((p) => p.title === "where to eat?").length, 2);
  w.tap(ASHWANI, "where", "Queen Tea");
  w.tap(PRINCY, "where", "Queen Tea");
  await tick(w);
  const sentAfterDone = w.texts.length;
  await tickPlans(w.deps); // a finished plan is no longer ticked
  assert.equal(w.texts.length, sentAfterDone);
  assert.equal((await w.plan(planId)).stage, "done");
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
  w.clock += 10_000; // 10s since the change: still open
  await advance(await w.plan(planId), w.deps);
  assert.equal((await ashwani()).answer, undefined);
  w.clock += 10_000;
  await advance(await w.plan(planId), w.deps);
  assert.deepEqual((await ashwani()).picks, ["20:00"]);
});

test("whoever answers first is told to hang tight, once, while the others are checked", async () => {
  const w = world();
  const { planId } = (await start(w)) as { planId: string };
  w.tap(ASHWANI, "what time", "7:00 PM");
  await go(w, planId);
  await go(w, planId);
  await go(w, planId);
  assert.equal(w.textsTo(ASHWANI).filter((t) => /hang tight/.test(t)).length, 1);
  assert.equal(w.textsTo(PRINCY).filter((t) => /hang tight/.test(t)).length, 0); // she hasn't answered yet
});

test("locations: people not sharing are asked, and the place is picked for where everyone is", async () => {
  const w = world({ locs: { [ASHAR]: HERE[ASHAR]! } });
  const { planId } = (await start(w)) as { planId: string };
  assert.deepEqual([...w.locRequests].sort(), [ASHWANI, PRINCY]);
  assert.match(w.textsTo(ASHWANI).at(-1)!, /share your location|tap share/);
  assert.equal(w.textsTo(ASHAR).length, 0); // the organizer already shares, so nothing to ask

  w.tap(ASHWANI, "what time", "7:00 PM");
  w.tap(PRINCY, "what time", "7:00 PM");
  await go(w, planId);
  // Two people haven't shared yet: the place waits, and everyone is told so.
  assert.equal(w.polls.filter((p) => p.title === "where to eat?").length, 0);
  assert.match(w.textsTo(ASHWANI).at(-1)!, /hang tight while i find a spot that's close to everyone/);

  w.locs[ASHWANI] = HERE[ASHWANI]!;
  w.locs[PRINCY] = HERE[PRINCY]!;
  await go(w, planId);
  assert.equal(w.polls.filter((p) => p.title === "where to eat?").length, 2);
  assert.deepEqual(w.originsSeen.at(-1), [HERE[ASHAR], HERE[ASHWANI], HERE[PRINCY]]);
  const poll = w.polls.find((p) => p.phone === ASHWANI && p.title === "where to eat?")!;
  assert.ok(poll.plan && poll.multi);
  assert.match(poll.options[0]!.label, /^Queen Tea · \d+ min$/); // each person sees their own walk
});

test("locations: after a few minutes it goes with whoever shared", async () => {
  const w = world({ locs: { [ASHAR]: HERE[ASHAR]!, [ASHWANI]: HERE[ASHWANI]! } });
  const { planId } = (await start(w)) as { planId: string };
  w.tap(ASHWANI, "what time", "7:00 PM");
  w.tap(PRINCY, "what time", "7:00 PM");
  await go(w, planId);
  assert.equal(w.polls.filter((p) => p.title === "where to eat?").length, 0);
  w.clock += 4 * 60_000;
  await advance(await w.plan(planId), w.deps);
  assert.equal(w.polls.filter((p) => p.title === "where to eat?").length, 2);
  assert.deepEqual(w.originsSeen.at(-1), [HERE[ASHAR], HERE[ASHWANI]]);
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
