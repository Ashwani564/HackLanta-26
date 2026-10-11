// Text one person directly (opening the chat if needed), from outside any conversation with them.
import { app as appCard, attachment, richlink } from "spectrum-ts";
import { type MeetupCard } from "./meetup-card.js";
import { meetupLayout } from "./meetup-art.js";
import { imessage } from "spectrum-ts/providers/imessage";

/** Returns the chat's GUID, which polls need. */
export async function sendDm(app: any, phone: string, text: string): Promise<string> {
  const im = imessage(app as any);
  const dm = await im.space.create(await im.user(phone));
  await dm.send(text);
  return dm.id;
}

/** Send one person a picture (like the plan card), opening the chat if needed. */
export async function sendDmImage(app: any, phone: string, image: Buffer, name = "plan.jpg"): Promise<void> {
  const im = imessage(app as any);
  const dm = await im.space.create(await im.user(phone));
  await dm.send(attachment(image, { name, mimeType: "image/jpeg" }));
}

/**
 * Send one person the plan card. Default: an iMessage rich link, whose big preview is the card art (the page's og:image,
 * see meetup-art.ts); it shows on every phone. PLAN_CARD=app sends the native app card instead (picture + caption row, like
 * the "Today's Pie" card), which some phones only draw as a small icon with captions. Falls back to the other format.
 */
export async function sendDmCard(app: any, phone: string, url: string, card: MeetupCard): Promise<void> {
  const im = imessage(app as any);
  const dm = await im.space.create(await im.user(phone));
  const asApp = async () => dm.send(appCard(url, { layout: await meetupLayout(card) }));
  const asLink = async () => dm.send(richlink(url));
  const [first, second] = process.env.PLAN_CARD === "app" ? [asApp, asLink] : [asLink, asApp];
  try {
    await first();
  } catch (err) {
    console.warn(`  plan card failed (${(err as Error).message}); trying the other format`);
    await second();
  }
}

/** Make sure a chat with this person exists, without sending anything. Returns its GUID (polls and location requests need it). */
export async function openDm(app: any, phone: string): Promise<string> {
  const im = imessage(app as any);
  return (await im.space.create(await im.user(phone))).id;
}
