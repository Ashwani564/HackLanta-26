// Text one person directly (opening the chat if needed), from outside any conversation with them.
import { attachment, richlink } from "spectrum-ts";
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

/** Send one person the plan card as an iMessage rich link (the page's og:image becomes the big preview), opening the chat if needed. */
export async function sendDmCard(app: any, phone: string, url: string): Promise<void> {
  const im = imessage(app as any);
  const dm = await im.space.create(await im.user(phone));
  await dm.send(richlink(url));
}

/** Make sure a chat with this person exists, without sending anything. Returns its GUID (polls and location requests need it). */
export async function openDm(app: any, phone: string): Promise<string> {
  const im = imessage(app as any);
  return (await im.space.create(await im.user(phone))).id;
}
