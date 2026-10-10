// Group chats: the bot stays quiet unless someone talks to it. In a one-on-one chat it always answers.
//
// "Talking to it" means saying one of its names ("hey bot, where should we eat"). After that, the same person's
// follow-ups (a restaurant name, a photo, a voice note) count as part of the conversation for a couple of
// minutes, so they don't have to say the name every time. Everyone else's chatter is ignored without being
// read by the model or stored.
import { getState, putState } from "./store.js";

/** Names the bot answers to in groups. Set BOT_NAMES (comma-separated) once it has a name. */
export const botNames = (): string[] =>
  (process.env.BOT_NAMES ?? "bot,food bot,dining agent")
    .split(",")
    .map((n) => n.trim().toLowerCase())
    .filter(Boolean);

/** iMessage group chat GUIDs look like "any;+;chat123"; one-on-one chats look like "any;-;+1555...". */
export const isGroupChat = (spaceId: string) => spaceId.includes(";+;");

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Does the text address the bot by name? Whole words only ("bot" matches "hey bot", not "robot"). */
export function mentionsBot(text: string, names: readonly string[] = botNames()): boolean {
  if (names.length === 0) return false;
  const pattern = new RegExp(`(^|[^a-z0-9])@?(${names.map(escape).join("|")})(?![a-z0-9])`, "i");
  return pattern.test(text);
}

const WINDOW_SECONDS = 150;
const attentionKey = (spaceId: string, sender: string) => `attn#${spaceId}#${sender}`;

/**
 * Should the bot handle this message? Always in a one-on-one chat. In a group, only when it's addressed by name,
 * or the same person addressed it in the last couple of minutes. (Poll votes are decided by the poll logic.)
 */
export async function shouldRespond(spaceId: string, sender: string | undefined, contentType: string, text?: string): Promise<boolean> {
  if (!isGroupChat(spaceId)) return true;
  if (contentType === "poll_option") return true;
  const key = sender ? attentionKey(spaceId, sender) : undefined;
  if (contentType === "text" && text && mentionsBot(text)) {
    if (key) await putState(key, Date.now(), WINDOW_SECONDS);
    return true;
  }
  if (key && (await getState<number>(key))) {
    if (contentType === "text") await putState(key, Date.now(), WINDOW_SECONDS); // keep the conversation going
    return true;
  }
  return false;
}
