// AWS Lambda entry point for Photon (Spectrum) webhooks.
//
//   Photon --POST--> Function URL --(verify HMAC, ack 200 fast)--> async self-invoke
//                                                                  └─> handle message, reply via Spectrum
//
// Photon times out a delivery after 30s and retries, and the SDK runs webhook handlers
// after the HTTP response, which Lambda would freeze. So the URL invocation only verifies
// and hands the raw delivery to an async invocation of this same function, which awaits
// the handler (including waiting for poll taps). Deliveries are at-least-once, so messages
// are deduped on message.id, and async retries are off so a slow flow never runs twice.
import { createHmac, timingSafeEqual } from "node:crypto";
import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { Spectrum } from "spectrum-ts";
import { imessage } from "spectrum-ts/providers/imessage";
import { createHandler } from "./handler.js";
import { loadSecrets } from "./secrets.js";
import { claimOnce } from "./store.js";

type Headers = Record<string, string | undefined>;
type Delivery = { kind: "delivery"; body: string; headers: Headers };

const lambda = new LambdaClient({ region: process.env.AWS_REGION ?? "us-east-2" });
// The handler may wait on poll taps for minutes (see handler.ts); stay under the function timeout.
const MAX_HANDLER_MS = 290_000;

// Reused across warm invocations.
let bot: Promise<{ app: any; handle: (space: any, message: any) => Promise<void> }> | undefined;
const getBot = () =>
  (bot ??= (async () => {
    await loadSecrets();
    const app = await Spectrum({
      providers: [imessage.config()],
      webhookSecret: process.env.SPECTRUM_WEBHOOK_SECRET,
      options: { logLevel: (process.env.LOG_LEVEL as "info" | "debug") ?? "info" },
    });
    return { app, handle: createHandler(app).handle };
  })());

export const handler = async (event: any, context: { functionName: string }) => {
  if (event?.kind === "delivery") return processDelivery(event as Delivery);
  if (event?.kind === "selftest") return selfTest(event.audioBase64);

  // Function URL request from Photon.
  if (event?.requestContext?.http?.method !== "POST") return { statusCode: 200, body: "dining-agent webhook" };
  const body = Buffer.from(event.body ?? "", event.isBase64Encoded ? "base64" : "utf8");
  const headers: Headers = event.headers ?? {};
  await loadSecrets();
  const check = verify(body, headers);
  if (check !== "ok") {
    console.warn(`rejected delivery: ${check}`);
    return { statusCode: check === "bad signature" ? 401 : 400, body: check };
  }
  await lambda.send(
    new InvokeCommand({
      FunctionName: context.functionName,
      InvocationType: "Event",
      Payload: Buffer.from(JSON.stringify({ kind: "delivery", body: body.toString("base64"), headers } satisfies Delivery)),
    }),
  );
  return { statusCode: 200, body: "ok" };
};

/** Same check as Photon's docs: HMAC-SHA256 over "v0:<timestamp>:<raw body>", 5-minute window. */
function verify(body: Buffer, headers: Headers): "ok" | "missing headers" | "stale timestamp" | "bad signature" {
  const secret = process.env.SPECTRUM_WEBHOOK_SECRET;
  const timestamp = headers["x-spectrum-timestamp"], signature = headers["x-spectrum-signature"];
  if (!secret || !timestamp || !signature || !headers["x-spectrum-event"]) return "missing headers";
  if (!(Math.abs(Date.now() / 1000 - Number(timestamp)) <= 300)) return "stale timestamp";
  const expected = Buffer.from("v0=" + createHmac("sha256", secret).update(`v0:${timestamp}:`).update(body).digest("hex"));
  const got = Buffer.from(signature);
  return expected.length === got.length && timingSafeEqual(expected, got) ? "ok" : "bad signature";
}

async function processDelivery({ body, headers }: Delivery) {
  const { app, handle } = await getBot();
  let started!: () => void, finished!: () => void;
  const didStart = new Promise<void>((r) => (started = r));
  const didFinish = new Promise<void>((r) => (finished = r));

  const result = await app.webhook({ body: Buffer.from(body, "base64"), headers }, async (space: any, message: any) => {
    started();
    try {
      if (message.direction === "outbound") return;
      if (!(await claimOnce(`msg#${message.id}`))) {
        console.log(`duplicate delivery for ${message.id}, skipped`);
        return;
      }
      await handle(space, message);
    } finally {
      finished();
    }
  });
  console.log(`delivery ${headers["x-spectrum-event"]}: sdk status ${result.status}`);
  if (result.status >= 300) return;

  // Events that aren't messages never call the handler; don't wait on them.
  const kickedOff = await Promise.race([didStart.then(() => true), sleep(3000).then(() => false)]);
  if (kickedOff) await Promise.race([didFinish, sleep(MAX_HANDLER_MS)]);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * `aws lambda invoke --payload '{"kind":"selftest"}'`: proves ffmpeg, Polly and Transcribe work inside Lambda.
 * Add `"audioBase64"` (e.g. an iPhone voice note, CAF/Opus) to check that a real recording is understood too.
 */
async function selfTest(audioBase64?: string) {
  const { canConvertAudio, speak, toWav, transcribe } = await import("./voice.js");
  if (!canConvertAudio()) return { ok: false, error: "ffmpeg not found (is the layer attached?)" };
  const started = Date.now();
  if (audioBase64) {
    const wav = await toWav(Buffer.from(audioBase64, "base64"));
    const heard = await transcribe(wav);
    return { ok: !!heard, input: "provided recording", wavBytes: wav.length, transcript: heard, ms: Date.now() - started };
  }
  const { audio, duration } = await speak("Try the beef rice at Queen Tea. It's about six hundred fifty calories.");
  const transcript = await transcribe(await toWav(audio));
  return { ok: !!transcript, voiceNoteBytes: audio.length, durationSeconds: +duration.toFixed(1), transcript, ms: Date.now() - started };
}
