import assert from "node:assert/strict";
import test from "node:test";
import { ASK_TEXT, ASK_TITLE, answerAsk, askStage, closeAsk, movedOn, offer, tapped, tickAsks, type AskIo } from "../../bot/src/health-ask.js";
import { setPublicBase, syncTokenFor } from "../../bot/src/health.js";
import type { PollSpec } from "../../bot/src/polls.js";

// No STATE_TABLE here, so store.ts keeps everything in memory. Each test uses its own person.
let n = 0;
const person = () => `+1555010${String(++n).padStart(4, "0")}`;
const chatOf = (user: string) => `any;-;${user}`;

const on = () => {
  process.env.HEALTH_SHORTCUT_URL = "https://www.icloud.com/shortcuts/abc123";
  setPublicBase("https://bot.example.test");
};
/** How long a first message waits for the tap. 0 = not at all. */
const hold = (ms: number) => (process.env.HEALTH_ASK_HOLD_MS = String(ms));

/** A pretend chat: what was texted, which polls went out, what history kept, and a finger to tap with. */
const world = (opts: { pollFails?: boolean } = {}) => {
  const texts: string[] = [];
  const polls: PollSpec[] = [];
  const history: [string, string][] = [];
  let vote: string | undefined;
  let sayFails = 0;
  const io: AskIo = {
    polls: {
      send: async (chatGuid, spec) => {
        if (opts.pollFails) throw new Error("polls are down");
        polls.push(spec);
        return { ...spec, guid: `g${polls.length}-${chatGuid}`, chatGuid, optionIds: {} };
      },
      read: async () => vote,
    },
    say: async (text) => {
      if (sayFails-- > 0) throw new Error("photon is down");
      texts.push(text);
    },
    remember: async (_space, user, bot) => void history.push([user, bot]),
  };
  return { io, texts, polls, history, tap: (v: string) => (vote = v), failNextSay: () => (sayFails = 1) };
};
const hasLink = (texts: string[]) => texts.some((t) => t.includes("https://bot.example.test/health/"));

test("nobody is asked while Health sync is off; they're asked once it's on, and only once", async () => {
  const user = person();
  delete process.env.HEALTH_SHORTCUT_URL;
  assert.equal(await askStage(user), "none");
  on();
  assert.equal(await askStage(user), "new");
  assert.equal(await askStage(user), "none");
});

test("someone who already has a sync link is never asked", async () => {
  on();
  const user = person();
  await syncTokenFor(user);
  assert.equal(await askStage(user), "none");
  assert.equal(await askStage(user), "none");
});

test("yes: the ask is a text and a yes/no poll, then the setup texts with their private link", async () => {
  on();
  hold(500);
  const user = person();
  const w = world();
  assert.equal(await askStage(user), "new");
  w.tap("yes");
  assert.equal(await offer(user, chatOf(user), "im hungry", w.io), true, "their first message is answered next");

  assert.equal(w.texts[0], ASK_TEXT);
  assert.match(ASK_TEXT, /apple health/);
  assert.match(ASK_TEXT, /personalized suggestions based on your health and diet goals/);
  assert.equal(w.polls.length, 1);
  assert.equal(w.polls[0]!.title, ASK_TITLE);
  assert.deepEqual(w.polls[0]!.options.map((o) => o.label), ["yes", "no"]);

  const token = await syncTokenFor(user);
  assert.ok(w.texts[1]!.split("\n\n").includes(`https://bot.example.test/health/${token}`), "the link is a bubble of its own");
  // History has what they said, the ask, and the tap, but never the link.
  assert.deepEqual(w.history[0], ["im hungry", ASK_TEXT]);
  assert.equal(w.history[1]![0], tapped("yes"));
  assert.ok(w.history.every(([u, b]) => !u.includes("http") && !b.includes("http")));
  assert.equal(await askStage(user), "none");
});

test("no: one short text, no link, and nothing is asked again", async () => {
  on();
  hold(500);
  const user = person();
  const w = world();
  await askStage(user);
  w.tap("no");
  assert.equal(await offer(user, chatOf(user), "hey", w.io), true);
  assert.equal(w.texts.length, 2);
  assert.match(w.texts[1]!, /all good/);
  assert.ok(!hasLink(w.texts));
  await tickAsks(() => w.io);
  assert.equal(w.texts.length, 2);
  assert.equal(await askStage(user), "none");
});

test("no tap in time: their message is answered anyway, and a later tap is caught by the minute check, once", async () => {
  on();
  hold(0);
  const user = person();
  const w = world();
  await askStage(user);
  assert.equal(await offer(user, chatOf(user), "im hungry", w.io), true);
  assert.deepEqual(w.texts, [ASK_TEXT]);

  await tickAsks(() => w.io);
  assert.deepEqual(w.texts, [ASK_TEXT], "nothing happens until they tap");

  w.tap("yes");
  await tickAsks(() => w.io);
  assert.ok(hasLink(w.texts));
  const sent = w.texts.length;
  await tickAsks(() => w.io);
  assert.equal(w.texts.length, sent, "the same tap is never answered twice");
});

test("a typed yes while their first message is on hold counts as the answer", async () => {
  on();
  hold(300);
  const user = person();
  const w = world();
  await askStage(user);
  const held = offer(user, chatOf(user), "im hungry", w.io);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(await askStage(user), "holding");
  assert.equal(await answerAsk(user, chatOf(user), "yes", "yeah", w.io), true);
  assert.equal(await held, true, "the held message is still answered");
  assert.ok(hasLink(w.texts));
  assert.equal(w.history.at(-1)![0], "yeah");
  // The poll is still sitting there; tapping it now does nothing more.
  w.tap("yes");
  const sent = w.texts.length;
  await tickAsks(() => w.io);
  assert.equal(w.texts.length, sent);
});

test("texting something else during the hold drops the held message, and the poll still works later", async () => {
  on();
  hold(300);
  const user = person();
  const w = world();
  await askStage(user);
  const held = offer(user, chatOf(user), "im hungry", w.io);
  await new Promise((r) => setTimeout(r, 30));
  await movedOn(user);
  assert.equal(await held, false, "the newer message is the one being answered");
  assert.equal(await askStage(user), "none", "a later yes is no longer read as the answer");

  w.tap("yes");
  await tickAsks(() => w.io);
  assert.ok(hasLink(w.texts));
});

test("if the poll can't be sent the question still goes out as a text", async () => {
  on();
  hold(0);
  const user = person();
  const w = world({ pollFails: true });
  await askStage(user);
  assert.equal(await offer(user, chatOf(user), "hey", w.io), true);
  assert.deepEqual(w.texts, [ASK_TEXT]);
  w.tap("yes"); // no poll to tap, so nothing is watching for one
  await tickAsks(() => w.io);
  assert.deepEqual(w.texts, [ASK_TEXT]);
});

test("asking to connect in chat settles the question, so a tap afterwards sends nothing", async () => {
  on();
  hold(0);
  const user = person();
  const w = world();
  await askStage(user);
  await offer(user, chatOf(user), "hey", w.io);
  await closeAsk(user);
  w.tap("yes");
  await tickAsks(() => w.io);
  assert.deepEqual(w.texts, [ASK_TEXT]);
});

test("a text that fails to send doesn't use up their answer", async () => {
  on();
  hold(0);
  const user = person();
  const w = world();
  await askStage(user);
  await offer(user, chatOf(user), "hey", w.io);
  w.tap("yes");
  w.failNextSay();
  await tickAsks(() => w.io);
  assert.ok(!hasLink(w.texts));
  await tickAsks(() => w.io);
  assert.ok(hasLink(w.texts), "the next check tries again");
});
