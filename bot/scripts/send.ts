// Usage: tsx --env-file=.env scripts/send.ts +15551234567 "message text"
import { Spectrum } from "spectrum-ts";
import { imessage } from "spectrum-ts/providers/imessage";

const [to, text] = process.argv.slice(2);
if (!to || !text) throw new Error('usage: send.ts <+phone> "<text>"');

const app = await Spectrum({ providers: [imessage.config()] });
const im = imessage(app);
const space = await im.space.create(await im.user(to));
await space.send(text);
console.log(`sent to ${to}`);
await app.stop();
