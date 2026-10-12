// Choice polls: send a native iMessage poll and find out what they tapped.
// Votes are read by polling the poll's state, so this works whether or not Photon's webhook
// forwards vote events. (If a vote does arrive as a message, handler.ts shares the same claim key.)
import { im } from "./photon.js";
import { getState, putState } from "./store.js";

// "health" is the one-time Apple Health question; health-ask.ts sends it and reads its answer.
export type PollKind = "restaurant" | "dish" | "health";
export interface PollSpec {
  kind: PollKind;
  /** Sent as a text right before the poll (e.g. naming the options), so the poll matches what was just said. */
  intro?: string;
  title: string;
  /** Owned by a meal plan: its engine reads the votes, so the chat handler must not answer them. */
  plan?: boolean;
  /** Several taps allowed; the plan waits for the person to stop tapping before it counts them. */
  multi?: boolean;
  /** label is what the person sees; value is what the flow gets back. */
  options: { label: string; value: string }[];
}
export interface PollRecord extends PollSpec {
  guid: string;
  chatGuid: string;
  optionIds: Record<string, string>; // optionIdentifier -> value
}

export interface PollApi {
  send(chatGuid: string, spec: PollSpec): Promise<PollRecord>;
  /** Resolves with the chosen value, or undefined on timeout / if a newer poll replaced this one. */
  wait(rec: PollRecord, opts: { timeoutMs: number }): Promise<string | undefined>;
  /** One look, no waiting: the chosen value if they've tapped. */
  read?(rec: PollRecord): Promise<string | undefined>;
}

const TTL = 6 * 3600;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const latestPollKey = (chatGuid: string) => `latestpoll#${chatGuid}`;
export const pollKey = (guid: string) => `poll#${guid}`;

async function send(chatGuid: string, spec: PollSpec): Promise<PollRecord> {
  const poll = await im.polls.create(chatGuid, spec.title, spec.options.map((o) => o.label));
  const optionIds: Record<string, string> = {};
  for (const opt of poll.options) {
    const match = spec.options.find((o) => o.label === opt.text);
    if (match) optionIds[opt.optionIdentifier] = match.value;
  }
  const rec: PollRecord = { ...spec, guid: poll.pollMessageGuid, chatGuid, optionIds };
  await putState(pollKey(rec.guid), rec, TTL);
  await putState(latestPollKey(chatGuid), rec.guid, TTL);
  return rec;
}

async function wait(rec: PollRecord, opts: { timeoutMs: number }): Promise<string | undefined> {
  const deadline = Date.now() + opts.timeoutMs;
  while (Date.now() < deadline) {
    await sleep(2000);
    // A newer poll in this chat (or a typed answer that started one) means this one is done.
    if ((await getState<string>(latestPollKey(rec.chatGuid))) !== rec.guid) return undefined;
    try {
      const poll = await im.polls.get(rec.guid);
      for (const vote of poll.votes) {
        const value = rec.optionIds[vote.optionIdentifier];
        if (value !== undefined) return value;
      }
    } catch (err) {
      console.warn(`  poll read failed: ${(err as Error).message}`);
    }
  }
  return undefined;
}

/** One look at a poll: the value of the first vote, or undefined if nobody has voted yet. */
export async function readVote(rec: PollRecord): Promise<string | undefined> {
  const poll = await im.polls.get(rec.guid);
  for (const vote of poll.votes) {
    const value = rec.optionIds[vote.optionIdentifier];
    if (value !== undefined) return value;
  }
  return undefined;
}

/** Every option currently ticked (iMessage polls allow several), in poll order. Empty if nothing is. */
export async function readVotes(rec: PollRecord): Promise<string[]> {
  const poll = await im.polls.get(rec.guid);
  const ticked = new Set(poll.votes.map((v) => rec.optionIds[v.optionIdentifier]).filter((v): v is string => v !== undefined));
  return rec.options.map((o) => o.value).filter((v) => ticked.has(v));
}

export const realPolls: PollApi = { send, wait, read: readVote };
