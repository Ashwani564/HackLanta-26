// Remove the project's Photon webhooks, so the old AWS Lambda stops getting messages and only the streaming bot
// (npm run start:free) answers. Undo with scripts/rewebhook.sh. Reads credentials from .env.free.
// Usage (from bot/): npx tsx scripts/unwebhook.mts
import { readFileSync } from "node:fs";

const env = Object.fromEntries(
  readFileSync(".env.free", "utf8")
    .split("\n")
    .filter((l) => l.includes("=") && !l.startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
);
const pid = env.SPECTRUM_PROJECT_ID;
const auth = "Basic " + Buffer.from(`${pid}:${env.SPECTRUM_PROJECT_SECRET}`).toString("base64");
const base = `https://spectrum.photon.codes/projects/${pid}/webhooks`;

const list = (await (await fetch(base, { headers: { authorization: auth } })).json()) as { data?: { id: string; webhookUrl: string }[] };
for (const w of list.data ?? []) {
  const r = await fetch(`${base}/${w.id}`, { method: "DELETE", headers: { authorization: auth } });
  console.log(`removed webhook ${w.id} (${w.webhookUrl}): ${r.status}`);
}
const after = (await (await fetch(base, { headers: { authorization: auth } })).json()) as { data?: unknown[] };
console.log(`webhooks left: ${(after.data ?? []).length}`);
