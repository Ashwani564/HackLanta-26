// Find My via Photon's low-level iMessage SDK (see photon.ts).
import { im } from "./photon.js";

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
  | { status: "not_shared"; reason: string };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(Math.random() * xs.length)]!;

const ASK_LINES = [
  "send me your location real quick so i can see what's around you",
  "drop me your location and i'll see what's close",
  "share your location with me, just tap the card, and i'll look around you",
  "one sec, need to see where you're at. tap share on this",
] as const;

/** A fix with coordinates, or undefined if they aren't sharing (or the device is still locating). */
async function read(address: string): Promise<Extract<LocationResult, { status: "sharing" }> | undefined> {
  try {
    const loc = await im.locations.get(address);
    if (loc.latitude === undefined || loc.longitude === undefined) return undefined;
    const ts = loc.locationTimestamp ? new Date(loc.locationTimestamp).getTime() : undefined;
    return {
      status: "sharing",
      latitude: loc.latitude,
      longitude: loc.longitude,
      ...(loc.shortAddress && { place: loc.shortAddress }),
      ...(loc.longAddress && { fullAddress: loc.longAddress }),
      ...(ts !== undefined && { ageMinutes: Math.max(0, Math.round((Date.now() - ts) / 60000)) }),
      justShared: false,
    };
  } catch (err: any) {
    if (err?.name === "NotFoundError") return undefined;
    throw err;
  }
}

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
  const now = await read(address);
  if (now) return now;

  await opts.say(pick(ASK_LINES));
  const receipt = await im.locations.request(chatGuid, address);
  console.log(`  find my request -> ${receipt.status}${receipt.reason ? ` (${receipt.reason})` : ""}`);

  const deadline = Date.now() + (opts.waitMs ?? 60_000);
  while (Date.now() < deadline) {
    await sleep(3000);
    const shared = await read(address);
    if (shared) return { ...shared, justShared: true };
  }
  return { status: "not_shared", reason: "they haven't tapped share yet" };
}
