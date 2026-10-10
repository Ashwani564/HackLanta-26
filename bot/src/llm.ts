// Chat brain on Amazon Bedrock (Claude, Converse API) with tool use.
// Model comes from BEDROCK_MODEL_ID; AWS credentials come from the default profile.
import {
  BedrockRuntimeClient,
  ConverseCommand,
  type ContentBlock,
  type Message,
  type Tool,
  type ToolInputSchema,
} from "@aws-sdk/client-bedrock-runtime";
import { SAFETY_CLAIM } from "../../src/pipeline/explain.js";
import { getState, putState } from "./store.js";

const client = new BedrockRuntimeClient({ region: process.env.AWS_REGION ?? "us-east-2" });
const modelId = () => {
  const id = process.env.BEDROCK_MODEL_ID;
  if (!id) throw new Error("BEDROCK_MODEL_ID is not set");
  return id;
};

const SYSTEM = `you're a friend who knows the food spots around georgia state, texting over imessage. you're not an assistant and you never sound like one.

how you text:
- like a real person: short, relaxed, mostly lowercase is fine. contractions. one to three short sentences.
- never say things like "great question", "certainly", "i'd be happy to", "sure thing!", "i hope this helps", "feel free to", or "let me know if". don't thank them, don't apologize unless you actually messed up.
- no markdown, no bullet points, no numbered lists, no bold. an emoji now and then is fine, never more than one, and often none.
- don't end every message with a question. don't repeat back what they just said. don't narrate what you're about to do.
- if a message has two separate thoughts, put a blank line between them and it goes out as two texts.
- say "yeah", "ok", "nice", "oh", "ha" like a person would. match their energy; if they're short with you, be short back.

what you can do:
- food: when they say they're hungry, want to eat, or ask where/what to eat, follow the flow below. you never guess where someone is and you never ask them to type their location.
- you can make polls, send voice notes, track their calories, and read photos of food (photos are handled automatically).
- you can be added to group chats; say yes if asked. never claim limits you weren't told about.

the food flow, in order:
1. call get_location first (pass any allergies or diets they've mentioned). it asks them to share their location (it already sends the ask and the card itself, so don't say anything before calling it), waits for them to tap share, and comes back with where they are plus the nearby restaurants. if it comes back not_shared, say something casual like "no worries, tap share on that card whenever and text me again" and stop.
2. then send two short texts with a blank line between them (that's what makes them two separate texts). like this, with the real details filled in:
[a quick remark about where they are]

couple spots close by, grab one
that blank line is required. first, a quick comment on where they are using place or full_address, like a friend who can see the map ("oh you're right by woodruff park"). never read out coordinates or a full street address. second, a short nudge to pick one, like "couple spots close, grab one". the spots (with walk times) go out as a poll right after your texts, so don't list or name them yourself. if age_minutes is over 20, ask whether they're still there before listing spots. poll_will_be_sent tells you whether the poll is going out; if it's false, explain why instead of nudging. if nearby.far_away is true, say honestly you only know the spots around campus and the closest one is x miles from them. if nearby.none_match_restrictions is true, say there's nothing close that works for that. if they add an allergy or diet later, call nearby_restaurants again.
3. when they type a restaurant instead of tapping the poll, call restaurant_dishes with it, even if it wasn't one of the spots offered. if they said what they're in the mood for, pass it as request. it sends the two dish picks and a poll to choose between them, so reply NO_REPLY after it. (when they tap a poll option the bot handles it by itself, you don't need to do anything.)
4. when they type which dish they want, call pick_dish. it sends a quick reaction and a poll asking if they want directions, so reply NO_REPLY after it.
5. if they type yes to directions (yeah, sure, yes please), call get_directions. it sends the map link. never send a map link or any url any other way, and never before they say yes. if they say no, just say ok.
choices always go out as polls (the tools send them), so never list options in text and ask "which one?".
if they ask what's good at a specific restaurant without the location part, skip straight to step 3.

allergies and diets: pass every allergy and diet they've mentioned anywhere in the conversation to the tools. never say a dish or restaurant is "safe", "allergen-free" or free of an allergen, and never name anyone's allergies in a group chat. restaurant_dishes adds its own allergy note.

other tools:
- create_poll: when the group wants to vote. pick 2-5 concrete options yourself if they don't give any.
- send_voice_note: only when they ask for a voice reply or sent you a voice note.
- log_meal: when they say they ate something ("i had a burrito"). estimate calories, protein and price. don't log things they're only thinking about.
- show_day / set_goals: how their day is going; their calorie, protein or budget targets. these send a "today's pie" card, so just add a few words.
if a tool already sent everything the person needs to see, reply with exactly NO_REPLY and nothing else.`;

export const VOICE_PROMPT = "I sent you a voice note. Respond to what I said, and reply with a voice note. Transcript:";

const schema = (json: Record<string, unknown>) => ({ json }) as ToolInputSchema;
const TOOLS: Tool[] = [
  {
    toolSpec: {
      name: "nearby_restaurants",
      description: "Restaurants near the person's shared location that have food they can eat. Call after get_location.",
      inputSchema: schema({
        type: "object",
        properties: {
          allergies: { type: "array", items: { type: "string" }, description: "Every allergy mentioned in this conversation" },
          diets: { type: "array", items: { type: "string" }, description: "Every diet restriction mentioned (vegan, vegetarian, gluten free, halal, kosher)" },
          budget_usd: { type: "number", description: "Max price per dish if mentioned" },
        },
        required: ["allergies", "diets"],
      }),
    },
  },
  {
    toolSpec: {
      name: "restaurant_dishes",
      description: "Picks two dishes at the restaurant they chose, with allergies and diets enforced in code, and sends them to the chat.",
      inputSchema: schema({
        type: "object",
        properties: {
          restaurant: { type: "string", description: "The restaurant they chose, as named in the nearby list" },
          request: { type: "string", description: "What they're in the mood for, in their words, if they said" },
          allergies: { type: "array", items: { type: "string" }, description: "Every allergy mentioned in this conversation" },
          diets: { type: "array", items: { type: "string" }, description: "Every diet restriction mentioned" },
          budget_usd: { type: "number", description: "Max price per dish if mentioned" },
        },
        required: ["restaurant", "allergies", "diets"],
      }),
    },
  },
  {
    toolSpec: {
      name: "pick_dish",
      description: "They typed which of the two offered dishes they want. Sends a quick reaction and the directions poll.",
      inputSchema: schema({
        type: "object",
        properties: { dish: { type: "string", description: "The dish they chose, in their words" } },
        required: ["dish"],
      }),
    },
  },
  {
    toolSpec: {
      name: "get_directions",
      description: "Sends the Apple Maps walking link to the restaurant they last picked dishes at. Only call after they say yes to directions.",
      inputSchema: schema({ type: "object", properties: {} }),
    },
  },
  {
    toolSpec: {
      name: "create_poll",
      description: "Send an iMessage poll into this chat.",
      inputSchema: schema({
        type: "object",
        properties: {
          question: { type: "string", description: "Short poll title" },
          options: { type: "array", items: { type: "string" }, description: "2-5 choices" },
        },
        required: ["question", "options"],
      }),
    },
  },
  {
    toolSpec: {
      name: "send_voice_note",
      description: "Send a spoken voice note into this chat.",
      inputSchema: schema({
        type: "object",
        properties: { text: { type: "string", description: "What to say, 1-3 sentences" } },
        required: ["text"],
      }),
    },
  },
  {
    toolSpec: {
      name: "get_location",
      description: "Find out where the sender is right now and which restaurants with food they can eat are nearby. If they aren't sharing, it texts them a casual ask, sends a Find My request card and waits for them to tap share. Never guess a location.",
      inputSchema: schema({
        type: "object",
        properties: {
          allergies: { type: "array", items: { type: "string" }, description: "Every allergy mentioned in this conversation" },
          diets: { type: "array", items: { type: "string" }, description: "Every diet restriction mentioned (vegan, vegetarian, gluten free, halal, kosher)" },
          budget_usd: { type: "number", description: "Max price per dish if mentioned" },
        },
      }),
    },
  },
  {
    toolSpec: {
      name: "log_meal",
      description: "Log a meal the sender ate today and update their Your day card.",
      inputSchema: schema({
        type: "object",
        properties: {
          name: { type: "string", description: "Dish name" },
          calories: { type: "number", description: "Estimated kcal" },
          protein_g: { type: "number", description: "Estimated grams of protein" },
          price_usd: { type: "number", description: "Price if known or typical, else 0" },
        },
        required: ["name", "calories", "protein_g"],
      }),
    },
  },
  {
    toolSpec: {
      name: "show_day",
      description: "Show the sender's Your day card (calories, protein, budget left today).",
      inputSchema: schema({ type: "object", properties: {} }),
    },
  },
  {
    toolSpec: {
      name: "set_goals",
      description: "Set the sender's daily targets. Only pass what they mentioned.",
      inputSchema: schema({
        type: "object",
        properties: { calories: { type: "number" }, protein_g: { type: "number" }, budget_usd: { type: "number" } },
      }),
    },
  },
];

/** The model returns exactly this when a tool already sent everything the person needs to see. */
export const NO_REPLY = "NO_REPLY";

function sentTextFrom(turn: Message[]): string | undefined {
  for (const m of [...turn].reverse()) {
    for (const b of m.content ?? []) {
      const text = (b.toolResult?.content?.[0] as { json?: { result?: { sent_text?: unknown } } } | undefined)?.json?.result?.sent_text;
      if (typeof text === "string") return text;
    }
  }
  return undefined;
}

/** Safety claims come from code, never the model. If one slips into a reply, rewrite it once, then fall back. */
async function scrubSafetyClaims(reply: string): Promise<string> {
  if (!SAFETY_CLAIM.test(reply)) return reply;
  try {
    const res = await client.send(
      new ConverseCommand({
        modelId: modelId(),
        system: [{ text: "Rewrite this text message so it does not say or imply any food, dish or restaurant is safe, allergen-free or free of anything. Keep the same casual tone, meaning and length. Output only the rewritten message." }],
        messages: [{ role: "user", content: [{ text: reply }] }],
        inferenceConfig: { maxTokens: 300, temperature: 0.3 },
      }),
    );
    const out = (res.output?.message?.content ?? []).map((b) => b.text ?? "").join("").trim();
    if (out && !SAFETY_CLAIM.test(out)) return out;
  } catch (err) {
    console.warn("  safety rewrite failed:", err);
  }
  return "double check the ingredients with them before you order";
}

export type ToolRunner = (name: string, args: Record<string, any>) => Promise<unknown>;

// Short rolling history per conversation, persisted via store.ts (DynamoDB in Lambda).
const MAX_MESSAGES = 20;
const HISTORY_TTL = 2 * 86400;
const historyKey = (spaceId: string) => `chat#${spaceId}`;
const loadHistory = async (spaceId: string) => (await getState<Message[]>(historyKey(spaceId))) ?? [];
// Bedrock content blocks may hold Uint8Array bytes; history only ever stores text/tool blocks, so JSON is safe.
const saveHistory = (spaceId: string, history: Message[]) => putState(historyKey(spaceId), trim(history), HISTORY_TTL);
const MAX_TOOL_ROUNDS = 3;

export async function chat(spaceId: string, text: string, runTool: ToolRunner): Promise<string> {
  const history = await loadHistory(spaceId);
  const turn: Message[] = [{ role: "user", content: [{ text }] }];

  for (let round = 0; ; round++) {
    const res = await client.send(
      new ConverseCommand({
        modelId: modelId(),
        system: [{ text: SYSTEM }],
        messages: [...history, ...turn],
        inferenceConfig: { maxTokens: 400, temperature: 0.7 },
        toolConfig: { tools: TOOLS },
      }),
    );
    const message = res.output?.message;
    if (!message) throw new Error("Bedrock returned no message");
    turn.push(message);

    const calls = (message.content ?? []).filter((b) => b.toolUse);
    if (res.stopReason !== "tool_use" || calls.length === 0 || round === MAX_TOOL_ROUNDS) {
      const text = (message.content ?? []).map((b) => b.text ?? "").join("").trim();
      const usedTools = turn.some((m) => m.content?.some((b) => b.toolResult));
      let reply = text.replace(/NO_REPLY/g, "").trim() === "" ? (usedTools || text ? NO_REPLY : "huh?") : text;
      if (reply !== NO_REPLY) reply = await scrubSafetyClaims(reply);
      if (calls.length > 0) turn.pop(); // never store a dangling tool call
      // What we remember saying: the real text when a tool sent it, never the NO_REPLY marker.
      const said = reply === NO_REPLY ? sentTextFrom(turn) ?? "ok" : reply;
      turn.push({ role: "assistant", content: [{ text: said }] });
      await saveHistory(spaceId, [...history, ...turn]);
      return reply;
    }

    const results: ContentBlock[] = [];
    for (const { toolUse } of calls) {
      console.log(`  tool ${toolUse!.name} ${JSON.stringify(toolUse!.input ?? {})}`);
      let result: unknown;
      let status: "success" | "error" = "success";
      try {
        result = await runTool(toolUse!.name!, (toolUse!.input as Record<string, any>) ?? {});
      } catch (err: any) {
        console.error(`  tool ${toolUse!.name} failed:`, err);
        result = { error: err?.message ?? String(err) };
        status = "error";
      }
      results.push({ toolResult: { toolUseId: toolUse!.toolUseId, content: [{ json: { result } as any }], status } });
    }
    turn.push({ role: "user", content: results });
  }
}

// Keep the last MAX_MESSAGES, starting on a plain user message so a tool call is
// never separated from its result.
function trim(history: Message[]): Message[] {
  let start = Math.max(0, history.length - MAX_MESSAGES);
  while (start < history.length) {
    const m = history[start]!;
    if (m.role === "user" && !(m.content ?? []).some((b) => b.toolResult)) break;
    start++;
  }
  return history.slice(start);
}

/** Record an exchange that happened outside chat() (e.g. an annotated photo) so follow-ups have context. */
export async function remember(spaceId: string, userText: string, modelText: string) {
  const history = await loadHistory(spaceId);
  history.push({ role: "user", content: [{ text: userText }] }, { role: "assistant", content: [{ text: modelText }] });
  await saveHistory(spaceId, history);
}

export async function reset(spaceId: string) {
  await putState(historyKey(spaceId), [], HISTORY_TTL);
}
