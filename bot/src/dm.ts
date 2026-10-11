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
 * Send one person the plan card as an iMessage app card (picture with the title over it, caption row under it, like the
 * "Today's Pie" card) that opens `url` when tapped. If the layout can't be sent it goes as a rich link instead.
 */
export async function sendDmCard(app: any, phone: string, url: string, card: MeetupCard): Promise<void> {
  const im = imessage(app as any);
  const dm = await im.space.create(await im.user(phone));
  try {
    await dm.send(appCard(url, { layout: await meetupLayout(card) }));
  } catch (err) {
    console.warn(`  app card failed, sending a rich link: ${(err as Error).message}`);
    await dm.send(richlink(url));
  }
}

/** Make sure a chat with this person exists, without sending anything. Returns its GUID (polls and location requests need it). */
export async function openDm(app: any, phone: string): Promise<string> {
  const im = imessage(app as any);
  return (await im.space.create(await im.user(phone))).id;
}
