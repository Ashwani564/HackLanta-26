import { Spectrum, poll, voice } from "spectrum-ts";
import { imessage } from "spectrum-ts/providers/imessage";
import { terminal } from "spectrum-ts/providers/terminal";
import { chat, reset, PHOTO_PROMPT, VOICE_PROMPT, VOICE_TRANSCRIPT_PROMPT, type ToolRunner } from "./gemini.js";
import { locate } from "./findmy.js";
import { speak, toWav, transcribe } from "./voice.js";

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
        await respond([
          { inlineData: { mimeType, data: Buffer.from(bytes).toString("base64") } },
          { text: PHOTO_PROMPT },
        ]);
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
