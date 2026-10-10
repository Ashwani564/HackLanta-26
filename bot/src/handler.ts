// Message handling shared by the local streaming bot (index.ts) and the Lambda webhook (lambda.ts).
import { attachment, poll, voice } from "spectrum-ts";
import { imessage } from "spectrum-ts/providers/imessage";
import { NO_REPLY, chat, remember, reset, VOICE_PROMPT, type ToolRunner } from "./llm.js";
import { locate as realLocate } from "./findmy.js";
import { canConvertAudio, speak, toWav, transcribe } from "./voice.js";
import { getDay, logMeal, setGoals, summary } from "./day.js";
import { sendDayCard } from "./card.js";
import { SAM_URL, analyzeFood, annotateFood, casualFoodReply } from "./vision.js";
import {
  askDirections, markAskedDirections, takeDirectionsAnswer, chooseDish, clearRestrictions, constraintsFor, directionsLink, dishPoll,
  mergeRestrictions, nearbyRestaurants, restaurantDishes, restaurantNamed, restaurantPoll, type Origin,
} from "./dining.js";
import { latestPollKey, pollKey, realPolls, type PollApi, type PollKind, type PollRecord, type PollSpec } from "./polls.js";
import { findUser, inviteMessage, registerUser, removeUser, toE164 } from "./invite.js";
import { claimOnce, getState, putState } from "./store.js";
import { warmDb } from "../../src/rag/store.js";
import { isGroupChat, shouldRespond } from "./addressing.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const LOC_TTL = 45 * 60;
// How long we keep an invocation alive waiting for taps. Photon only needs our fast 200, so this can be long.
const WAIT_MS = 150_000;
const CHAIN_MS = Number(process.env.POLL_CHAIN_MS ?? 270_000);

/** Build the per-message handler. `app` is the Spectrum instance (needed to open DMs for invites). */
export function createHandler(app: any, deps: { locate?: typeof realLocate; polls?: PollApi } = {}) {
  const locate = deps.locate ?? realLocate;
  const pollApi = deps.polls ?? realPolls;
  return { handle, invite };

  async function handle(space: any, message: any) {
  // Read receipts and typing signals are noise for now.
  if (message.content.type === "read" || message.content.type === "typing") return;

  // In a group chat, stay quiet unless someone talks to the bot. Chatter that isn't for it is dropped here, before
  // anything reads or stores it, and isn't even logged.
  const text = message.content.type === "text" ? (message.content.text as string) : undefined;
  if (!(await shouldRespond(space.id, message.sender?.id, message.content.type, text))) {
    console.log(`[${message.platform}] group chat: not addressed to me, staying quiet`);
    return;
  }

  const from = message.sender?.id ?? "unknown";
  const body = text !== undefined ? ` "${text}"` : "";
  console.log(`[${message.platform}] ${space.id} ${from}: ${message.content.type}${body}`);

  // The next choice to offer as a poll. Sent after the reply text so the order reads naturally.
  let queued: PollSpec | undefined;
  // What the person just said (a transcript for voice notes). Used to read a restaurant name straight from their words.
  let currentText = "";

  // A blank line in a reply means "send as a separate text", paced like someone typing.
  const sendBubbles = async (sp: any, text: string) => {
    const parts = text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
    for (const [i, part] of parts.entries()) {
      if (i > 0) await sp.responding(() => sleep(Math.min(2200, Math.max(700, part.length * 16))));
      await sp.send(part);
    }
  };

  /** The dish step: sends the two picks, then queues the "which one?" poll (or straight to directions). */
  const offerDishes = async (args: { restaurant: string; request?: string; allergies?: unknown; diets?: unknown; budget_usd?: unknown }) => {
    const restrictions = await mergeRestrictions(space.id, args);
    const origin = (await getState<Origin>(`loc#${space.id}`)) ?? undefined;
    const budget = typeof args.budget_usd === "number" ? args.budget_usd : undefined;
    const out = await restaurantDishes(space.id, args, constraintsFor(restrictions, budget), origin);
    if (!out.text) return { error: out.error ?? "couldn't find that one", options: out.options };
    await sendBubbles(space, out.text);
    console.log(`  dishes: ${out.text.replace(/\n+/g, " | ")}`);
    queued = dishPoll(out.restaurant!, out.choices!);
    // Only one pick to choose from means no poll; go straight to the directions question (text).
    if (!queued) {
      const ask = askDirections();
      await space.send(ask);
      await markAskedDirections(space.id);
      // The model must see the question it was just answered "sure" to, or it re-runs the dish search.
      return { sent: true, sent_text: `${out.text}\n\n${ask}` };
    }
    return { sent: true, sent_text: out.text };
  };

  /** What a tapped (or typed) choice leads to. Returns what we said and the next poll, if any. */
  const advance = async (kind: PollKind, value: string): Promise<{ said?: string; next?: PollSpec }> => {
    switch (kind) {
      case "restaurant": {
        const before = queued;
        const r = await offerDishes({ restaurant: value });
        const next = queued !== before ? queued : undefined;
        queued = undefined;
        return { said: "sent_text" in r ? r.sent_text : r.error, ...(next && { next }) };
      }
      case "dish": {
        const out = await chooseDish(space.id, value);
        if (!out.text) {
          await space.send("hm, which one did you mean?");
          return {};
        }
        await sendBubbles(space, out.text);
        return { said: out.text };
      }
    }
  };

  /** Send each queued poll, wait for the tap, answer it, and carry on until there's nothing left to ask. */
  const runPolls = async (first: PollSpec | undefined) => {
    const deadline = Date.now() + CHAIN_MS;
    let spec = first;
    while (spec && Date.now() < deadline) {
      let rec: PollRecord;
      try {
        // Name the options in a text first, then poll on exactly those.
        if (spec.intro) await sendBubbles(space, spec.intro);
        rec = await pollApi.send(space.id, spec);
      } catch (err) {
        console.warn(`  poll failed, asking in text instead: ${(err as Error).message}`);
        await space.send(`${spec.options.map((o) => o.value).join(", ")}?`);
        return;
      }
      console.log(`  poll: ${spec.title} [${spec.options.map((o) => o.label).join(" | ")}]`);
      const value = await pollApi.wait(rec, { timeoutMs: Math.min(WAIT_MS, deadline - Date.now()) });
      if (value === undefined) return; // no tap in time, or they typed instead; the next message takes over
      if (!(await claimOnce(`voted#${rec.guid}`))) return; // the vote also arrived as a message and was handled there
      console.log(`  voted: ${value}`);
      const step = await advance(rec.kind, value);
      await remember(space.id, `(tapped "${value}" in the poll "${rec.title}")`, step.said ?? "ok");
      spec = step.next;
    }
  };

  // Side effects the model can trigger mid-conversation.
  const runTool: ToolRunner = async (name, args) => {
    switch (name) {
      case "create_poll":
        await space.send(poll(args.question, args.options));
        return { sent: true };
      case "send_voice_note": {
        if (!canConvertAudio()) return { error: "Voice notes aren't available on this server yet; reply in text." };
        const { audio, duration } = await speak(args.text);
        await space.send(voice(audio, { name: "voice-note.m4a", mimeType: "audio/mp4", duration }));
        return { sent: true };
      }
      case "log_meal":
      case "show_day":
      case "set_goals": {
        const user = message.sender?.id ?? "unknown";
        const day =
          name === "log_meal"
            ? await logMeal(user, {
                name: args.name,
                calories: args.calories,
                protein: args.protein_g,
                price: args.price_usd ?? 0,
              })
            : name === "set_goals"
              ? await setGoals(user, { calories: args.calories, protein: args.protein_g, budget: args.budget_usd })
              : await getDay(user);
        const card = await sendDayCard(space, day);
        return { card, ...summary(day) };
      }
      case "get_location": {
        if (message.platform !== "imessage" || !message.sender) return { error: "location only works over iMessage" };
        warmDb(); // wake the database now, while they're still tapping share
        const loc = await locate(space.id, message.sender.id, { say: (t) => space.send(t) });
        if (loc.status !== "sharing") return loc;
        const origin: Origin = { lat: loc.latitude, lng: loc.longitude };
        await putState(`loc#${space.id}`, origin, LOC_TTL);
        // Coordinates stay server-side; the model only gets the human-readable place and the nearby spots.
        const { latitude: _lat, longitude: _lng, ...forModel } = loc;
        const restrictions = await mergeRestrictions(space.id, args);
        const near = await nearbyRestaurants(space.id, origin, constraintsFor(restrictions, args.budget_usd));
        console.log(`  at: ${loc.place ?? "?"} | nearby: ${near.restaurants.map((r) => `${r.name} ${r.walk_minutes}min`).join(", ") || "none"}${near.far_away ? " (far away)" : ""}`);
        // The spots go out as a poll right after the model's text; the model shouldn't list them itself.
        queued = restaurantPoll(near);
        return { ...forModel, nearby: near, poll_will_be_sent: !!queued };
      }
      case "nearby_restaurants": {
        const origin = await getState<Origin>(`loc#${space.id}`);
        if (!origin) return { error: "no location yet. call get_location first" };
        const restrictions = await mergeRestrictions(space.id, args);
        const near = await nearbyRestaurants(space.id, origin, constraintsFor(restrictions, args.budget_usd));
        console.log(`  nearby: ${near.restaurants.map((r) => `${r.name} ${r.walk_minutes}min`).join(", ") || "none"}${near.far_away ? " (far away)" : ""}`);
        queued = restaurantPoll(near);
        return { ...near, poll_will_be_sent: !!queued };
      }
      case "restaurant_dishes":
        // If they named a restaurant, trust their words over whatever the model passed.
        return offerDishes({ ...(args as { restaurant: string; request?: string }), restaurant: restaurantNamed(currentText) ?? String(args.restaurant ?? "") });
      case "pick_dish": {
        const out = await chooseDish(space.id, String(args.dish ?? ""));
        if (!out.text) return { error: out.error ?? "couldn't match that dish" };
        await sendBubbles(space, out.text);
        return { sent: true, sent_text: out.text };
      }
      case "get_directions": {
        const dir = await directionsLink(space.id);
        if (!dir.url) return { error: dir.error };
        await space.send(dir.url);
        return { sent: true, sent_text: `here's the walk to ${dir.name}: ${dir.url}` };
      }
      default:
        return { error: `unknown tool ${name}` };
    }
  };
  const respond = async (text: string) => {
    currentText = text;
    await space.responding(async () => {
      const reply = await chat(space.id, text, runTool);
      console.log(`  -> ${reply}`);
      if (reply !== NO_REPLY) await sendBubbles(space, reply);
    });
    // Polls go out after the text, outside the typing indicator, and we wait for the tap.
    const next = queued;
    queued = undefined;
    await runPolls(next);
  };

  try {
    switch (message.content.type) {
      case "text": {
        const text = message.content.text;
        if (text.trim().toLowerCase() === "/reset") {
          await reset(space.id);
          await clearRestrictions(space.id);
          await putState(`loc#${space.id}`, null, 1);
          await message.reply("ok, fresh start");
          return;
        }
        if (text.trim().toLowerCase() === "stop" && message.sender) {
          // Reply first: once removed, the shared line can't message them.
          await message.reply("ok, you're unsubscribed. text me anytime if you want back in");
          await removeUser(message.sender.id);
          console.log(`  opted out ${message.sender.id}`);
          return;
        }
        // A bare "sure"/"no" right after "want directions?" is answered here; the model has misread it as a new search.
        const answer = await takeDirectionsAnswer(space.id, text);
        if (answer === "yes") {
          const out = (await runTool("get_directions", {})) as { sent?: boolean; sent_text?: string; error?: string };
          await remember(space.id, text, out.sent_text ?? "ok");
          if (!out.sent) await space.send("hm, i don't have a spot picked yet. which one are you headed to?");
          break;
        }
        if (answer === "no") {
          await space.send("ok, just text me if you need anything");
          await remember(space.id, text, "ok, just text me if you need anything");
          break;
        }
        await respond(text);
        break;
      }
      case "attachment": {
        const { name, mimeType } = message.content;
        if (!mimeType.startsWith("image/")) {
          await message.reply("i can only read photos for now");
          return;
        }
        await message.react("👀");
        const bytes = await message.content.read();
        console.log(`  image ${name} ${mimeType} ${bytes.length} bytes`);
        // With a SAM 2 server (SAM_URL): reply with the same photo, items outlined and labeled.
        // Without one: reply with the per-item calorie breakdown as text.
        const { image, items, timings } = SAM_URL
          ? await annotateFood(Buffer.from(bytes))
          : { ...(await analyzeFood(Buffer.from(bytes))), image: undefined };
        console.log(`  food: ${items.map((it) => `${it.label} ${it.calories}cal`).join(", ") || "none"} ${JSON.stringify(timings)}`);
        if (items.length === 0) {
          await message.react("🤔");
          return;
        }
        if (image) await space.send(attachment(image, { name: "calories.jpg", mimeType: "image/jpeg" }));
        else await space.responding(async () => space.send(await casualFoodReply(items)));
        const cal = items.reduce((a, it) => a + (Number(it.calories) || 0), 0);
        await remember(
          space.id,
          "[I sent a food photo]",
          `[Annotated it] ${items.map((it) => `${it.label}: ~${it.calories} cal, ~${it.protein_g}g protein`).join("; ")}. Total ~${cal} cal (est.)`,
        );
        break;
      }
      case "voice": {
        if (!canConvertAudio()) {
          await message.reply("can't listen to voice notes right now, mind typing it?");
          return;
        }
        const bytes = await message.content.read();
        console.log(`  voice ${message.content.mimeType} ${bytes.length} bytes`);
        const wav = await toWav(bytes);
        const transcript = await transcribe(wav);
        if (!transcript) {
          await message.reply("didn't catch that, can you type it?");
          return;
        }
        console.log(`  transcript: ${transcript}`);
        await respond(`${VOICE_PROMPT} "${transcript}"`);
        break;
      }
      case "contact":
        await invite(space, message);
        break;
      case "poll_option": {
        // A vote that arrived as a message (the waiting loop in runPolls reads votes directly too;
        // whichever sees it first claims it, so the answer is only sent once).
        const c = message.content;
        console.log(`  vote ${c.selected ? "+" : "-"} "${c.option?.title ?? c.title}" on "${c.poll?.title ?? "?"}"`);
        if (!c.selected) return;
        const guid = await getState<string>(latestPollKey(space.id));
        const rec = guid ? await getState<PollRecord>(pollKey(guid)) : undefined;
        const label = c.option?.title ?? c.title;
        const value = rec?.options.find((o) => o.label === label)?.value;
        if (!rec || value === undefined) {
          console.log("  vote isn't on a poll we're waiting on; ignoring");
          return;
        }
        if (!(await claimOnce(`voted#${rec.guid}`))) return;
        console.log(`  voted (message): ${value}`);
        const step = await advance(rec.kind, value);
        await remember(space.id, `(tapped "${value}" in the poll "${rec.title}")`, step.said ?? "ok");
        await runPolls(step.next);
        break;
      }
      default:
        console.log("  (unhandled content type)");
    }
  } catch (err) {
    console.error("  handler error:", err);
    await space.send("ugh, something broke on my end. try me again in a sec");
  }
}

/** Contact card shared with the bot -> register that friend and text them an intro. */
  async function invite(space: any, message: any) {
  const card = message.content;
  const raw = (card.phones ?? []).find((p: any) => p.type === "mobile") ?? card.phones?.[0];
  const phone = raw && toE164(raw.value);
  const first = card.name?.first ?? card.name?.formatted?.split(" ")[0];
  if (!phone) {
    await message.reply("that contact doesn't have a number i can text");
    return;
  }
  if (message.platform !== "imessage") {
    await message.reply(`invites only work over imessage, so i can't add ${first ?? phone} here`);
    return;
  }

  const inviter = message.sender && (await findUser(message.sender.id));
  const user = await registerUser(phone, first, card.name?.last);
  console.log(`  invited ${phone} -> line ${user.assignedPhoneNumber ?? "?"}`);

  // app is a terminal|imessage union; we only get here on iMessage.
  const im = imessage(app as any);
  const dm = await im.space.create(await im.user(phone));
  await dm.send(inviteMessage(first, inviter?.firstName ?? "Your friend"));

  await message.react("👍");
  await message.reply(`ok, texted ${first ?? phone}. once they answer i'll know what they can eat too`);
}
}
