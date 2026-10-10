// Find My via Photon's low-level iMessage SDK. Spectrum doesn't expose
// locations, so we open our own client with the same project credentials.
import { createGrpcClient } from "@photon-ai/advanced-imessage/grpc";

const id = process.env.SPECTRUM_PROJECT_ID!;
const secret = process.env.SPECTRUM_PROJECT_SECRET!;
const ADDRESS = process.env.SPECTRUM_IMESSAGE_ADDRESS ?? "imessage.spectrum.photon.codes:443";

let token: { value: string; expiresAt: number } | undefined;

async function getToken(): Promise<string> {
  if (token && Date.now() < token.expiresAt) return token.value;
  const res = await fetch(`https://spectrum.photon.codes/projects/${id}/imessage/tokens`, {
    method: "POST",
    headers: {
      authorization: "Basic " + Buffer.from(`${id}:${secret}`).toString("base64"),
      "content-type": "application/json",
    },
    body: "{}",
  });
  const { data } = await res.json();
  // Renew at 80% of the TTL, like spectrum-ts does.
  token = { value: data.token, expiresAt: Date.now() + data.expiresIn * 800 };
  return token.value;
}

const im = createGrpcClient({ address: ADDRESS, tls: true, retry: true, token: getToken });

export type LocationResult =
  | { status: "sharing"; place?: string; latitude?: number; longitude?: number; freshness: string }
  | { status: "requested"; note: string };

/** Returns the person's location if they share it with us, otherwise sends a Find My request card. */
export async function locate(chatGuid: string, address: string): Promise<LocationResult> {
  try {
    const loc = await im.locations.get(address);
    return {
      status: "sharing",
      place: loc.shortAddress ?? loc.longAddress,
      latitude: loc.latitude,
      longitude: loc.longitude,
      freshness: loc.locationType,
    };
  } catch (err: any) {
    if (err?.name !== "NotFoundError") throw err;
  }
  const receipt = await im.locations.request(chatGuid, address);
  console.log(`  find my request -> ${receipt.status}${receipt.reason ? ` (${receipt.reason})` : ""}`);
  return {
    status: "requested",
    note: "Sent a Find My request card. They need to accept it, then ask again.",
  };
}
