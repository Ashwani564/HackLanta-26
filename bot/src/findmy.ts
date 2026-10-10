// Find My via Photon's low-level iMessage SDK (see photon.ts).
import { im } from "./photon.js";
import { getState, putState } from "./store.js";

export type LocationResult =
  | {
      status: "sharing";
      latitude: number;
      longitude: number;
      /** Short and full street-level descriptions from Find My (e.g. a landmark or street). */
      place?: string;
      fullAddress?: string;
      /** How old the fix is. Live shares are ~0. */
      ageMinutes?: number;
      /** True when they tapped share just now, in answer to our request. */
      justShared: boolean;
    }
  | { status: "not_shared"; reason: string; /** We already asked a moment ago and are waiting for their tap; don't ask again. */ already_asked?: boolean };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(Math.random() * xs.length)]!;

const ASK_LINES = [
  "send me your location real quick so i can see what's around you",
  "drop me your location and i'll see what's close",
  "share your location with me, just tap the card, and i'll look around you",
  "one sec, need to see where you're at. tap share on this",
] as const;

type Fix = Extract<LocationResult, { status: "sharing" }>;
/** "locating" means they ARE sharing but the phone hasn't produced coordinates yet: wait, don't ask again. */
type Read = { fix: Fix } | { locating: true } | { none: true };

async function read(address: string): Promise<Read> {
  try {
    const loc = await im.locations.get(address);
    if (loc.latitude === undefined || loc.longitude === undefined) return { locating: true };
    const ts = loc.locationTimestamp ? new Date(loc.locationTimestamp).getTime() : undefined;
    return {
      fix: {
        status: "sharing",
        latitude: loc.latitude,
        longitude: loc.longitude,
        ...(loc.shortAddress && { place: loc.shortAddress }),
        ...(loc.longAddress && { fullAddress: loc.longAddress }),
        ...(ts !== undefined && { ageMinutes: Math.max(0, Math.round((Date.now() - ts) / 60000)) }),
        justShared: false,
      },
    };
  } catch (err: any) {
    if (err?.name === "NotFoundError") return { none: true };
    throw err;
  }
}

const askedKey = (chatGuid: string) => `askedloc#${chatGuid}`;

/**
 * Where is this person right now? Reads their Find My share if they have one running. If not, says so
 * in a casual line (via `say`), sends the Find My request card, and waits up to `waitMs` for them to tap
 * share. Never guesses and never reuses an old location.
 */
export async function locate(
  chatGuid: string,
  address: string,
  opts: { say: (text: string) => Promise<unknown>; waitMs?: number },
): Promise<LocationResult> {
  // 1. Already sharing? Then there is nothing to ask. Use it straight away.
  let now = await read(address);
  if ("fix" in now) return now.fix;

  // 2. Sharing, but the phone is still working out where it is: give it a few seconds, still without asking.
  if ("locating" in now) {
    for (let i = 0; i < 6 && "locating" in now; i++) {
      await sleep(2000);
      now = await read(address);
    }
    if ("fix" in now) return { ...now.fix, justShared: true };
    return { status: "not_shared", reason: "they're sharing but their phone hasn't produced a location yet" };
  }

  // 3. Not sharing. Ask once: if a request is already out and we're waiting on their tap, don't pile on another card.
  if (await getState<number>(askedKey(chatGuid))) {
    return { status: "not_shared", reason: "already asked, waiting for them to tap share on the card above", already_asked: true };
  }
  const waitMs = opts.waitMs ?? 60_000;
  await putState(askedKey(chatGuid), Date.now(), Math.ceil(waitMs / 1000) + 15);
  try {
    await opts.say(pick(ASK_LINES));
    const receipt = await im.locations.request(chatGuid, address);
    console.log(`  find my request -> ${receipt.status}${receipt.reason ? ` (${receipt.reason})` : ""}`);

    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
      await sleep(3000);
      const shared = await read(address);
      if ("fix" in shared) return { ...shared.fix, justShared: true };
    }
    return { status: "not_shared", reason: "they haven't tapped share yet" };
  } finally {
    await putState(askedKey(chatGuid), null, 1);
  }
}

/** One quiet look at someone's Find My share: their coordinates, or undefined if they aren't sharing (yet). Never asks. */
export async function peekLocation(address: string): Promise<{ lat: number; lng: number } | undefined> {
  try {
    const now = await read(address);
    return "fix" in now ? { lat: now.fix.latitude, lng: now.fix.longitude } : undefined;
  } catch {
    return undefined;
  }
}

/** Send the Find My request card (once per person for a while) without waiting for the tap. */
export async function requestLocation(chatGuid: string, address: string): Promise<void> {
  if (await getState<number>(askedKey(chatGuid))) return;
  await putState(askedKey(chatGuid), Date.now(), 600);
  const receipt = await im.locations.request(chatGuid, address);
  console.log(`  find my request (plan) -> ${receipt.status}${receipt.reason ? ` (${receipt.reason})` : ""}`);
}
