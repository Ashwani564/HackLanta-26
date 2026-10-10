// One low-level Photon iMessage client (Find My, polls) shared across the bot. Spectrum doesn't
// expose these, so we open our own with the same project credentials.
import { createGrpcClient } from "@photon-ai/advanced-imessage/grpc";

const ADDRESS = process.env.SPECTRUM_IMESSAGE_ADDRESS ?? "imessage.spectrum.photon.codes:443";

let token: { value: string; expiresAt: number } | undefined;

async function getToken(): Promise<string> {
  if (token && Date.now() < token.expiresAt) return token.value;
  // Read credentials at call time: in Lambda they arrive from Secrets Manager after module load.
  const id = process.env.SPECTRUM_PROJECT_ID!, secret = process.env.SPECTRUM_PROJECT_SECRET!;
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

export const im = createGrpcClient({ address: ADDRESS, tls: true, retry: true, token: getToken });

