// Entry point: load secrets from AWS first, then start the bot. index.ts is imported
// dynamically because some modules read credentials from the environment at load time.
import { loadSecrets } from "./secrets.js";

if ((process.env.MODE ?? "imessage") !== "terminal") await loadSecrets();
await import("./index.js");
