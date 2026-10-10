// Local streaming bot: holds a long-lived Spectrum connection and handles messages
// as they arrive. The Lambda webhook entry point is lambda.ts; both share handler.ts.
import { Spectrum } from "spectrum-ts";
import { imessage } from "spectrum-ts/providers/imessage";
import { terminal } from "spectrum-ts/providers/terminal";
import { startWeb } from "./web.js";
import { createHandler } from "./handler.js";

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

const { handle } = createHandler(app);
startWeb();
console.log(`dining-agent listening (${mode})`);

for await (const [space, message] of app.messages) {
  if (message.direction === "outbound") continue;
  // Handle each message without blocking the stream, so one slow reply
  // doesn't hold up everyone else.
  void handle(space, message);
}
