import { Spectrum, attachment, poll, voice } from "spectrum-ts";
import { imessage } from "spectrum-ts/providers/imessage";
import { terminal } from "spectrum-ts/providers/terminal";
import { chat, remember, reset, VOICE_PROMPT, VOICE_TRANSCRIPT_PROMPT, type ToolRunner } from "./gemini.js";
import { locate } from "./findmy.js";
import { speak, toWav, transcribe } from "./voice.js";
import { getDay, logMeal, setGoals, summary } from "./day.js";
import { sendDayCard } from "./card.js";
import { startWeb } from "./web.js";
import { annotateFood } from "./vision.js";
import { findUser, inviteMessage, registerUser, removeUser, toE164 } from "./invite.js";

// MODE=terminal runs locally with no credentials (tuichat UI).
// MODE=imessage (default) connects to Photon's managed iMessage lines.
const mode = process.env.MODE ?? "imessage";

const options = { logLevel: (process.env.LOG_LEVEL as "info" | "debug") ?? "info" };

// Credentials are read from SPECTRUM_PROJECT_ID / SPECTRUM_PROJECT_SECRET.
const app =
  mode === "terminal"
    ? await Spectrum({ providers: [terminal.config()], options })
    : await Spectrum({ providers: [imessage.config()], options });

process.on("SIGINT", async () => {
  await app.stop();
  process.exit(0);
});

startWeb();
console.log(`dining-agent listening (${mode})`);

for await (const [space, message] of app.messages) {
  if (message.direction === "outbound") continue;
  // Handle each message without blocking the stream, so one slow reply
  // doesn't hold up everyone else.
  void handle(space, message);
}

async function handle(space: any, message: any) {
  // Read receipts and typing signals are noise for now.
  if (message.content.type === "read" || message.content.type === "typing") return;

  const from = message.sender?.id ?? "unknown";
  const body = message.content.type === "text" ? ` "${message.content.text}"` : "";
  console.log(`[${message.platform}] ${space.id} ${from}: ${message.content.type}${body}`);

  // Side effects Gemini can trigger mid-conversation.
  const runTool: ToolRunner = async (name, args) => {
    switch (name) {
      case "create_poll":
        await space.send(poll(args.question, args.options));
        return { sent: true };
      case "send_voice_note": {
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
            ? logMeal(user, {
                name: args.name,
                calories: args.calories,
                protein: args.protein_g,
                price: args.price_usd ?? 0,
              })
            : name === "set_goals"
              ? setGoals(user, { calories: args.calories, protein: args.protein_g, budget: args.budget_usd })
              : getDay(user);
        const card = await sendDayCard(space, day);
        return { card, ...summary(day) };
      }
      case "get_location":
        if (message.platform !== "imessage" || !message.sender) return { error: "Location only works in iMessage" };
        return await locate(space.id, message.sender.id);
      default:
        return { error: `unknown tool ${name}` };
    }
  };
  const respond = (parts: Parameters<typeof chat>[1]) =>
    space.responding(async () => {
      const reply = await chat(space.id, parts, runTool);
      console.log(`  -> ${reply}`);
      await space.send(reply);
    });

  try {
    switch (message.content.type) {
      case "text": {
        const text = message.content.text;
        if (text.trim().toLowerCase() === "/reset") {
          reset(space.id);
          await message.reply("Fresh start 🧹");
          return;
        }
        if (text.trim().toLowerCase() === "stop" && message.sender) {
          // Reply first: once removed, the shared line can't message them.
          await message.reply("You're unsubscribed. Text any time if you want back in 👋");
          await removeUser(message.sender.id);
          console.log(`  opted out ${message.sender.id}`);
          return;
        }
        await respond([{ text }]);
        break;
      }
      case "attachment": {
        const { name, mimeType } = message.content;
        if (!mimeType.startsWith("image/")) {
          await message.reply("I can only read photos for now 📸");
          return;
        }
        await message.react("👀");
        const bytes = await message.content.read();
        console.log(`  image ${name} ${mimeType} ${bytes.length} bytes`);
        // Reply with the same photo, food items outlined and labeled. No text.
        const { image, items, timings } = await annotateFood(Buffer.from(bytes));
        console.log(`  food: ${items.map((it) => `${it.label} ${it.calories}cal`).join(", ") || "none"} ${JSON.stringify(timings)}`);
        if (items.length === 0) {
          await message.react("🤔");
          return;
        }
        await space.send(attachment(image, { name: "calories.jpg", mimeType: "image/jpeg" }));
        const cal = items.reduce((a, it) => a + (Number(it.calories) || 0), 0);
        remember(
          space.id,
          "[I sent a food photo]",
          `[Annotated it] ${items.map((it) => `${it.label}: ~${it.calories} cal, ~${it.protein_g}g protein`).join("; ")}. Total ~${cal} cal (est.)`,
        );
        break;
      }
      case "voice": {
        const bytes = await message.content.read();
        console.log(`  voice ${message.content.mimeType} ${bytes.length} bytes`);
        const wav = await toWav(bytes);
        const transcript = await transcribe(wav);
        if (transcript) {
          console.log(`  transcript: ${transcript}`);
          await respond([{ text: `${VOICE_TRANSCRIPT_PROMPT} "${transcript}"` }]);
        } else {
          // No ElevenLabs key or Scribe failed: let Gemini understand the raw audio.
          await respond([
            { inlineData: { mimeType: "audio/wav", data: wav.toString("base64") } },
            { text: VOICE_PROMPT },
          ]);
        }
        break;
      }
      case "contact":
        await invite(space, message);
        break;
      case "poll_option":
        console.log(`  vote ${message.content.selected ? "+" : "-"} "${message.content.title}"`);
        break;
      default:
        console.log("  (unhandled content type)");
    }
  } catch (err) {
    console.error("  handler error:", err);
    await space.send("Something broke on my end, try again in a sec.");
  }
}

/** Contact card shared with the bot -> register that friend and text them an intro. */
async function invite(space: any, message: any) {
  const card = message.content;
  const raw = (card.phones ?? []).find((p: any) => p.type === "mobile") ?? card.phones?.[0];
  const phone = raw && toE164(raw.value);
  const first = card.name?.first ?? card.name?.formatted?.split(" ")[0];
  if (!phone) {
    await message.reply("That contact doesn't have a phone number I can text 🤔");
    return;
  }
  if (message.platform !== "imessage") {
    await message.reply(`Would invite ${first ?? phone}, but invites only work over iMessage.`);
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
  await message.reply(`Invited ${first ?? phone} ✅ I just texted them. Once they reply, I'll know their diet too.`);
}
