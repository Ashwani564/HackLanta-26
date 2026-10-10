// Local conversation simulator: real Bedrock + real database + real dish picking; Find My is faked.
// Usage: tsx --env-file=.env chat-sim.mts <scenario>
import { createHandler } from "./src/handler.ts";
import { casualFoodReply } from "./src/vision.ts";

const where: Record<string, any> = {
  gsu: { status: "sharing", latitude: 33.7536, longitude: -84.3868, place: "Georgia State University", fullAddress: "Peachtree Center Ave SE, Atlanta, GA", ageMinutes: 0, justShared: true },
  far: { status: "sharing", latitude: 33.4504, longitude: -88.8184, place: "Starkville", fullAddress: "Main St, Starkville, MS", ageMinutes: 0, justShared: true },
  never: { status: "not_shared", reason: "they haven't tapped share yet" },
};
const scenario = process.argv[2] ?? "basic";
const loc = scenario === "far" ? where.far : scenario === "never" ? where.never : where.gsu;

let n = 0;
const space = (id: string) => ({
  id,
  send: async (t: any) => console.log(`   📱 ${typeof t === "string" ? t.replace(/\n/g, "\n      ") : "[card/other]"}`),
  responding: async (fn: () => Promise<any>) => fn(),
});
const sp = space(scenario === "group" ? `any;+;chat-sim-${Date.now()}` : `any;-;+1555000${scenario.length}${Date.now() % 1000}`);
// Fake polls: print the poll, then "tap" the next choice from the scenario's plan (index or value).
const taps: (number | string)[] = scenario === "polls" ? [0, 0, "yes"] : scenario === "polls-no" ? [1, 1, "no"] : scenario === "polls-skip" ? [] : [];
const polls = {
  send: async (chatGuid: string, spec: any) => {
    console.log(`   📊 poll "${spec.title}"  [ ${spec.options.map((o: any) => o.label).join("  |  ")} ]`);
    return { ...spec, guid: `g${n++}`, chatGuid, optionIds: {} };
  },
  wait: async (rec: any) => {
    const t = taps.shift();
    if (t === undefined) { console.log("   ⏳ (nobody taps; they type instead)"); return undefined; }
    const opt = typeof t === "number" ? rec.options[t] : rec.options.find((o: any) => o.value === t);
    console.log(`   👆 taps "${opt.label}"`);
    return opt.value;
  },
};
const { handle } = createHandler({}, {
  polls,
  locate: async (_c: string, _a: string, o: any) => {
    if (loc.status !== "sharing") await o.say("send me your location real quick so i can see what's around you");
    return loc;
  },
});
const say = async (raw: string) => {
  // In the group scenario, "other: ..." is a different person talking.
  const other = raw.startsWith("other: ");
  const text = other ? raw.slice(7) : raw;
  console.log(`\n🙋 ${other ? "(someone else) " : ""}${text}`);
  const t = Date.now();
  await handle(sp, { id: `m${n++}`, platform: "imessage", direction: "inbound", sender: { id: other ? "+15550002222" : "+15550001111" }, content: { type: "text", text }, reply: async (t: string) => sp.send(t), react: async () => {} });
  console.log(`   (${((Date.now() - t) / 1000).toFixed(1)}s)`);
};

const scripts: Record<string, string[]> = {
  basic: ["yo im hungry", "moes"],
  polls: ["yo im hungry"],
  "polls-no": ["i could eat, what's around"],
  "polls-skip": ["im starving"],
  typed: ["hungry", "queen tea", "the beef rice", "yeah"],
  friend: ["Need a place to eat with my friend", "hey"],
  group: ["anyone want tacos", "other: lol i'm so tired", "hey bot im hungry", "queen tea", "other: i'm good", "ok thanks"],
  price: ["hungry", "mr fries man", "strikeout wingz", "mangos", "stir house", "saxbys", "starbucks"],
  allergy: ["im allergic to peanuts, need something to eat", "india eats", "something spicy"],
  far: ["what should i eat"],
  never: ["i need food"],
  chat: ["hey", "lol ok", "can you make a poll for where to eat tonight"],
  directions: ["i am hungry", "queen tea", "yeah", "thanks"],
  nodirections: ["hungry af", "india eats", "nah im good"],
};
for (const m of scripts[scenario] ?? scripts.basic!) await say(m);

if (scenario === "photo") {
  console.log("\n📷 photo replies:");
  const items = [{ label: "Rice", box_2d: [0, 0, 1, 1], calories: 200, protein_g: 4 }, { label: "Grilled chicken", box_2d: [0, 0, 1, 1], calories: 250, protein_g: 31 }, { label: "Broccoli", box_2d: [0, 0, 1, 1], calories: 30, protein_g: 3 }, { label: "Sauce", box_2d: [0, 0, 1, 1], calories: 50, protein_g: 1 }, { label: "Orange juice", box_2d: [0, 0, 1, 1], calories: 110, protein_g: 2 }] as any;
  for (let i = 0; i < 4; i++) console.log("   📱", await casualFoodReply(items));
  console.log("   📱", await casualFoodReply([{ label: "Burger", box_2d: [0, 0, 1, 1], calories: 650, protein_g: 30 }, { label: "Fries", box_2d: [0, 0, 1, 1], calories: 380, protein_g: 5 }] as any));
}
process.exit(0);
