// Plan cards are sent as Spectrum "app" cards: a tappable iMessage card that opens a small page. This is that page's
// storage: the card's details (place, time, who's going) under an unguessable token, served from the Lambda URL.
import { randomBytes } from "node:crypto";
import type { MeetupCard } from "./meetup-card.js";
import { getState, putState } from "./store.js";

const CARD_TTL = 14 * 86400;
const BASE_KEY = "baseurl";
let knownBase: string | undefined;

/** The Lambda's public URL, learned from any request to it (the webhook calls it all the time). */
export async function rememberBaseUrl(domainName: string | undefined): Promise<void> {
  if (!domainName) return;
  const base = `https://${domainName}`;
  if (base === knownBase) return;
  knownBase = base;
  await putState(BASE_KEY, base);
}

/** Our public URL, if a request has taught it to us yet. */
export const baseUrl = async () => knownBase ?? (await getState<string>(BASE_KEY));

const TOKEN = /^[A-Za-z0-9_-]{8,40}$/;
export const isCardToken = (s: string) => TOKEN.test(s);

/** Save the card and return the link to send, or undefined if our own URL isn't known yet. */
export async function publishCard(card: MeetupCard): Promise<string | undefined> {
  const base = knownBase ?? (await getState<string>(BASE_KEY));
  if (!base) return undefined;
  const token = randomBytes(9).toString("base64url");
  await putState(`card#${token}`, card, CARD_TTL);
  return `${base}/card/${token}`;
}

export const loadCard = (token: string) => (isCardToken(token) ? getState<MeetupCard>(`card#${token}`) : Promise.resolve(undefined));
