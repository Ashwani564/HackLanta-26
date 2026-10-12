// Entry point: load secrets from AWS first, then start the bot. index.ts is imported
// dynamically because some modules read credentials from the environment at load time.
import { loadSecrets } from "./secrets.js";

// On Render, links in cards (and Apple Health sync) use the service's public address.
if (!process.env.PUBLIC_URL && process.env.RENDER_EXTERNAL_URL) process.env.PUBLIC_URL = process.env.RENDER_EXTERNAL_URL;

if ((process.env.MODE ?? "imessage") !== "terminal") await loadSecrets();
await import("./index.js");
