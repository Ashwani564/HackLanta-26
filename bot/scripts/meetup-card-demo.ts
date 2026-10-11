// Usage: tsx --env-file=.env scripts/meetup-card-demo.ts +15551234567 ["reply text"]
// Texts the reply, then sends the "it's on" meetup card (same card the plan flow ends with) for demo purposes.
import { Spectrum, app as appCard } from "spectrum-ts";
import { imessage } from "spectrum-ts/providers/imessage";
import { publishCard, rememberBaseUrl } from "../src/cards.js";
import { type MeetupCard, meetupJpeg } from "../src/meetup-card.js";
import { loadSecrets } from "../src/secrets.js";

const [to, reply = "yes that works for me"] = process.argv.slice(2);
if (!to) throw new Error('usage: meetup-card-demo.ts <+phone> ["reply text"]');

const card: MeetupCard = {
  meal: "dinner",
  place: "Stir House Atlanta",
  time: "7:30 PM",
  date: new Date().toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric", timeZone: "America/New_York" }),
  people: [{ name: "ashar", walkMin: 6 }, { name: "princy", walkMin: 4 }],
  note: "closest spot to both of you · farthest walk 6 min",
};

if (!process.env.STATE_TABLE) throw new Error("set STATE_TABLE to the dining-bot DynamoDB table, or the card is saved in memory and the Lambda can't serve it");
// The Lambda normally learns its own URL from webhook requests; CARD_HOST (e.g. abc123.lambda-url.us-east-2.on.aws) seeds it.
await rememberBaseUrl(process.env.CARD_HOST);
const url = await publishCard(card);
if (!url) throw new Error("card base URL isn't known yet: set CARD_HOST to the Lambda Function URL host");

await loadSecrets(); // Photon project credentials from Secrets Manager (same as the Lambda)
const app = await Spectrum({ providers: [imessage.config()] });
const im = imessage(app);
const space = await im.space.create(await im.user(to));

await space.send(reply);
await space.send(
  appCard(url, {
    layout: {
      caption: `${card.place} · ${card.time}`,
      subcaption: `${card.people.length} going`,
      image: new Uint8Array(await meetupJpeg(card)),
      imageTitle: "It's on",
      imageSubtitle: `${card.meal}, ${card.date}`,
      summary: `${card.meal} at ${card.place}, ${card.time}`,
    },
  }),
);
console.log(`sent reply + card to ${to}`);
await app.stop();
