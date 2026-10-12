// The one-time "want to connect apple health?" question. A new person gets it before their first message is
// answered, as a yes/no poll, in a one-on-one chat only (the sync link it leads to is private, see health.ts).
//
//   first message -> the ask + poll -> their message is held for a moment while they tap
//     yes -> the setup texts (connectHealth)     no -> "all good"     then their message is answered as usual
//
// Photon doesn't forward poll taps, so the tap is read here: every couple of seconds during the hold, then once
// a minute (tickAsks) for a few hours. A typed "yes"/"no" during the hold counts too. Whichever notices the
// answer first claims it, so it is only acted on once.
import { keyFor } from "./day.js";
import { connectHealth, hasSyncLink, healthSyncReady } from "./health.js";
import type { PollRecord, PollSpec } from "./polls.js";
import { claimOnce, getState, putState, releaseLease } from "./store.js";

export type AskAnswer = "yes" | "no";

/** What the ask needs from the running bot. */
export type AskIo = {
  /** `read` is one look at a poll: the value tapped, if any. Without it only a typed answer counts. */
  polls: { send(chatGuid: string, spec: PollSpec): Promise<PollRecord>; read?(rec: PollRecord): Promise<string | undefined> };
  /** Text the person. A blank line splits it into separate texts. */
  say(text: string): Promise<unknown>;
  /** Put an exchange into the chat history, so the model knows what was asked and what they answered. */
  remember(spaceId: string, userText: string, botText: string): Promise<unknown>;
};

export const ASK_TITLE = "connect apple health?";
export const ASK_TEXT =
  "before we get into it, want to connect your apple health? then i can give you personalized suggestions based on your health and diet goals";
const DECLINED_TEXT = "all good. if you change your mind just tell me to connect apple health";
const askPoll = (): PollSpec => ({ kind: "health", title: ASK_TITLE, options: [{ label: "yes", value: "yes" }, { label: "no", value: "no" }] });

/** How a tap is written into the chat history (the same wording the dish and restaurant polls use). */
export const tapped = (answer: AskAnswer) => `(tapped "${answer}" in the poll "${ASK_TITLE}")`;

// How long their first message waits for the tap before it is answered anyway.
const holdMs = () => Number(process.env.HEALTH_ASK_HOLD_MS ?? 45_000);
const LOOK_EVERY_MS = 2000;
// A run that is holding looks this stale only if it died; after that a typed "yes" is no longer read as the answer.
const HOLD_SLACK_MS = 10_000;
// How long after the ask a late tap still counts.
const OPEN_MS = 6 * 3600_000;
const KEEP = 5 * 365 * 86400;

/**
 * holding: the run that asked is waiting on the answer, with their first message in hand.
 * open:    it stopped waiting; only a tap on the poll counts now.
 * done:    answered, or they connected by asking for it.
 */
type Ask = { state: "holding" | "open" | "done"; at: number; rec?: PollRecord };

const askKey = (userId: string) => `healthask#${keyFor(userId)}`;
// Held by whoever is acting on the answer, so it is acted on once.
const answerKey = (userId: string) => `healthanswer#${keyFor(userId)}`;
const load = (userId: string) => getState<Ask>(askKey(userId));
const save = (userId: string, ask: Ask) => putState(askKey(userId), ask);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// People whose poll may still be tapped, for the every-minute check. A handful at most, so one item is fine.
const WATCHED = "healthasks#watched";
const watched = async () => (await getState<string[]>(WATCHED)) ?? [];
const watch = async (userId: string) => {
  const list = await watched();
  if (!list.includes(userId)) await putState(WATCHED, [...list, userId]);
};
const unwatch = async (userId: string) => {
  const list = await watched();
  if (list.includes(userId)) await putState(WATCHED, list.filter((u) => u !== userId));
};

const close = async (userId: string, ask: Ask | undefined) => {
  await save(userId, { ...ask, state: "done", at: ask?.at ?? Date.now() });
  await unwatch(userId);
};

/**
 * Where this person stands, looked up on each one-on-one message:
 *   "new"      never asked and Health sync is set up, so ask now (true once per person, even if two messages race)
 *   "holding"  their first message is on hold in another run, waiting for the answer
 *   "none"     nothing to do
 * Nobody is asked while Health sync is off, and someone who already has a sync link is never asked.
 */
export async function askStage(userId: string): Promise<"new" | "holding" | "none"> {
  const ask = await load(userId);
  if (ask) return ask.state === "holding" && Date.now() - ask.at < holdMs() + HOLD_SLACK_MS ? "holding" : "none";
  if (!(await healthSyncReady())) return "none";
  if (await hasSyncLink(userId)) {
    await close(userId, undefined);
    return "none";
  }
  return (await claimOnce(`healthasked#${keyFor(userId)}`, KEEP)) ? "new" : "none";
}

const look = async (io: AskIo, rec: PollRecord): Promise<AskAnswer | undefined> => {
  try {
    const value = await io.polls.read?.(rec);
    return value === "yes" || value === "no" ? value : undefined;
  } catch (err) {
    console.warn(`  health ask: couldn't read the poll: ${(err as Error).message}`);
    return undefined;
  }
};

/**
 * Ask, then hold `firstText` (what they just sent) until they answer or the hold runs out. Returns whether to
 * go on and answer that message: false only when they've texted something else since, which its own run answers.
 */
export async function offer(userId: string, chatGuid: string, firstText: string, io: AskIo): Promise<boolean> {
  await io.say(ASK_TEXT);
  let rec: PollRecord | undefined;
  try {
    rec = await io.polls.send(chatGuid, askPoll());
  } catch (err) {
    console.warn(`  health ask: poll failed, a typed yes or no still counts: ${(err as Error).message}`);
  }
  await save(userId, { state: "holding", at: Date.now(), ...(rec && { rec }) });
  if (rec) await watch(userId);
  await io.remember(chatGuid, firstText, ASK_TEXT);

  const until = Date.now() + holdMs();
  while (Date.now() < until) {
    const now = await load(userId);
    if (now?.state === "done") return true; // answered by a typed reply or the minute check
    if (now?.state === "open") return false;
    const vote = rec && (await look(io, rec));
    if (vote) {
      await answerAsk(userId, chatGuid, vote, tapped(vote), io);
      break;
    }
    await sleep(Math.min(LOOK_EVERY_MS, Math.max(0, until - Date.now())));
  }
  // An answer taken elsewhere may still be sending its texts: let those finish before their message is answered.
  for (let i = 0; i < 15 && (await getState(answerKey(userId))) && (await load(userId))?.state !== "done"; i++) await sleep(1000);
  const last = await load(userId);
  if (last?.state === "holding") await save(userId, { ...last, state: "open" });
  return last?.state !== "open";
}

/** They texted something that isn't a yes or no while their first message was on hold: stop holding it. */
export async function movedOn(userId: string): Promise<void> {
  const ask = await load(userId);
  if (ask?.state === "holding") await save(userId, { ...ask, state: "open" });
}

/**
 * Act on their answer, once: yes sends the setup texts and their private link, no leaves it at that. `heard`
 * is what goes into the chat history as their side of it. Returns false if the answer was already taken.
 */
export async function answerAsk(userId: string, chatGuid: string, answer: AskAnswer, heard: string, io: AskIo): Promise<boolean> {
  const claim = answerKey(userId);
  if (!(await claimOnce(claim, KEEP))) return false;
  console.log(`  health ask: ${answer}`);
  let said = DECLINED_TEXT;
  let text = DECLINED_TEXT;
  if (answer === "yes") {
    const out = await connectHealth(userId, false);
    // The link is a credential: it is sent, and `said` (what history keeps) never holds it.
    text = "error" in out ? "hm, apple health isn't set up on my end right now. ask me again in a bit" : out.text;
    said = "error" in out ? text : out.said;
  }
  try {
    await io.say(text);
  } catch (err) {
    await releaseLease(claim); // nothing reached them, so the next look at the poll can try again
    throw err;
  }
  await close(userId, await load(userId));
  await io.remember(chatGuid, heard, said);
  return true;
}

/** They connected by asking for it instead, so the poll no longer needs an answer. */
export async function closeAsk(userId: string): Promise<void> {
  const ask = await load(userId);
  if (!ask || ask.state === "done") return;
  await claimOnce(answerKey(userId), KEEP);
  await close(userId, ask);
}

/** The every-minute check: a tap that came after the hold is noticed here, for a few hours after the ask. */
export async function tickAsks(ioFor: (userId: string) => AskIo): Promise<void> {
  for (const userId of await watched()) {
    const ask = await load(userId);
    if (!ask?.rec || ask.state === "done" || Date.now() - ask.at > OPEN_MS) {
      await unwatch(userId);
      continue;
    }
    const io = ioFor(userId);
    const vote = await look(io, ask.rec);
    if (!vote) continue;
    await answerAsk(userId, ask.rec.chatGuid, vote, tapped(vote), io).catch((err) => console.warn(`  health ask: couldn't answer a tap: ${(err as Error).message}`));
  }
}
