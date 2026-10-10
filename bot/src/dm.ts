// Text one person directly (opening the chat if needed), from outside any conversation with them.
import { attachment } from "spectrum-ts";
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
