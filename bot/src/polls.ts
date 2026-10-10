// Choice polls: send a native iMessage poll and find out what they tapped.
// Votes are read by polling the poll's state, so this works whether or not Photon's webhook
// forwards vote events. (If a vote does arrive as a message, handler.ts shares the same claim key.)
import { im } from "./photon.js";
import { getState, putState } from "./store.js";

export type PollKind = "restaurant" | "dish" | "directions";
export interface PollSpec {
  kind: PollKind;
  title: string;
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

export const realPolls: PollApi = { send, wait };
