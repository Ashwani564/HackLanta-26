/**
 * Run the whole RAG path on one message and print every step.
 *
 *   npm run search -- "allergic to peanuts, recommend something thai"
 *   npm run search -- "vegan high protein lunch under $10" --allergy milk --diet vegan --budget 12
 *
 * --allergy / --diet / --budget stand in for stored profile restrictions.
 */
import { parseArgs } from "node:util";
import { parseMessage, buildConstraints } from "../src/pipeline/parse.js";
import { routeMessage } from "../src/pipeline/route.js";
import { recommend } from "../src/pipeline/recommend.js";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    allergy: { type: "string", multiple: true, default: [] },
    diet: { type: "string", multiple: true, default: [] },
    budget: { type: "string" },
    lat: { type: "string" },
    lng: { type: "string" },
  },
});
const text = positionals.join(" ").trim();
if (!text) throw new Error('usage: npm run search -- "message" [--allergy x] [--diet y] [--budget n]');

const parsed = await parseMessage(text);
console.log("parsed     ", JSON.stringify(parsed));
const route = routeMessage(parsed);
console.log("route      ", route);
if (route !== "recommend") process.exit(0);

const constraints = buildConstraints(
  {
    allergies: values.allergy ?? [],
    diets: values.diet ?? [],
    ...(values.budget && { budgetMaxUsd: Number(values.budget) }),
  },
  parsed,
);
console.log("constraints", JSON.stringify(constraints));

const origin = values.lat && values.lng ? { lat: Number(values.lat), lng: Number(values.lng) } : undefined;
const rec = await recommend(text, parsed, constraints, origin ? { origin } : {});
const leakCount = Object.values(rec.leaked).reduce((a, b) => a + b, 0);
console.log(`retrieved   ${rec.candidates.length} candidates (kinds: ${rec.kinds.join(",") || "any"}${rec.widened ? ", widened" : ""})${leakCount > 0 ? `  !! code filter rejected ${leakCount} rows SQL returned: ${JSON.stringify(rec.leaked)}` : ""}`);
console.log("\n" + rec.reply);
