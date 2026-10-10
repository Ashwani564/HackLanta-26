// Usage: tsx --env-file=.env scripts/health-sim.ts
// The whole Apple Health loop with no phone: the real bot on Bedrock, state in memory, and this script
// playing the iPhone shortcut (pull the meals, ack them, send numbers back). Nobody is messaged.
import { createHandler } from "../src/handler.js";
import { handleHealthRequest, setPublicBase, syncTokenFor } from "../src/health.js";

// Stand-ins so the bot will hand out setup steps; the real values come from the deploy.
process.env.HEALTH_SHORTCUT_URL ??= "https://www.icloud.com/shortcuts/example";
setPublicBase("https://your-bot.example");

const me = "+15550001111";
const space = {
  id: `any;-;${me}`,
  send: async (t: any) => console.log(`   📱 ${typeof t === "string" ? t : "[today's pie card]"}`),
  responding: async (fn: () => Promise<any>) => fn(),
};
const { handle } = createHandler({});
let n = 0;
const say = async (text: string) => {
  console.log(`\n🙋 ${text}`);
  await handle(space, { id: `m${n++}`, platform: "imessage", direction: "inbound", sender: { id: me }, content: { type: "text", text }, reply: async (t: string) => space.send(t), react: async () => {} });
};
const phone = async (method: string, route: string, body?: unknown) =>
  (await handleHealthRequest(method, `/health/${await syncTokenFor(me)}/${route}`, body === undefined ? "" : JSON.stringify(body))).body as any;

await say("i had a chicken burrito bowl for lunch");
await say("can you connect apple health");

console.log("\n📲 the shortcut runs. it would write these to Health:");
const { meals } = await phone("GET", "pending");
for (const m of meals) {
  const extra = [m.carbs !== undefined && `${m.carbs}g carbs`, m.fat !== undefined && `${m.fat}g fat`].filter(Boolean).join(", ");
  console.log(`   🍽  ${m.name}: ${m.calories} kcal, ${m.protein}g protein${extra ? `, ${extra}` : ""}`);
}
await phone("POST", "ack", { ids: meals.map((m: any) => m.id) });
console.log(`   ✅ acked. meals still waiting to sync: ${(await phone("GET", "pending")).meals.length}`);
await phone("POST", "metrics", { active_kcal: 420, steps: 8200 });
console.log("   🏃 and it sends back from Health: 420 active calories, 8,200 steps");

await say("how's my day looking");
process.exit(0);
