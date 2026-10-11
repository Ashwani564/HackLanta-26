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


/**
 * Download a received attachment through Photon's API. Used when the webhook delivers an attachment without its
 * bytes (voice notes arrive that way, and Spectrum's iMessage provider has no getAttachment to fetch them).
 */
export async function downloadMessageAttachment(messageGuid: string): Promise<{ bytes: Buffer; mimeType: string } | undefined> {
  const msg = await im.messages.get(messageGuid);
  const att = msg.content.attachments.find((a) => !a.isHidden) ?? msg.content.attachments[0];
  if (!att) return undefined;
  const chunks: Uint8Array[] = [];
  for await (const chunk of im.attachments.downloadStream(att.guid)) if (chunk.type === "primaryChunk") chunks.push(chunk.data);
  const bytes = Buffer.concat(chunks);
  return bytes.length > 0 ? { bytes, mimeType: att.mimeType } : undefined;
}
