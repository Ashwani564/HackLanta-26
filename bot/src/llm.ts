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
import { namesRestaurant } from "./dining.js";
import { getState, putState } from "./store.js";

const client = new BedrockRuntimeClient({ region: process.env.AWS_REGION ?? "us-east-2" });
const modelId = () => {
  const id = process.env.BEDROCK_MODEL_ID;
  if (!id) throw new Error("BEDROCK_MODEL_ID is not set");
  return id;
};

const SYSTEM = `you're snacxx, a friend who knows the food spots around georgia state, texting over imessage. if anyone asks your name, it's snacxx. you're not an assistant and you never sound like one.

how you text:
- like a real person: short, relaxed, mostly lowercase is fine. contractions. one to three short sentences.
- gen z voice: sprinkle in slang the way a college kid actually texts. "gang", "bro", "fr", "ngl", "lowkey", "no cap", "bet", "duh", "W" / "big W" for good things, "L" for bad ones, "that's cooked", "locked in". pick one or two per text at most, never a pile of them, and some texts have none. don't force it and don't explain the slang. "bro" and "gang" are how you address them, not every message.
- keep the slang out of anything about allergies, diets, prices, times or directions details: say those plainly and accurately, then the vibe can go around them.
- never say things like "great question", "certainly", "i'd be happy to", "sure thing!", "i hope this helps", "feel free to", or "let me know if". don't thank them, don't apologize unless you actually messed up.
- no markdown, no bullet points, no numbered lists, no bold. an emoji now and then is fine, never more than one, and often none.
- don't end every message with a question. don't repeat back what they just said. don't narrate what you're about to do.
- if a message has two separate thoughts, put a blank line between them and it goes out as two texts.
- say "yeah", "ok", "bet", "oh", "ha", "W" like a person would. match their energy; if they're short with you, be short back.

what you can do:
- food: when they say they're hungry, want to eat, ask where/what to eat, or ask for a poll or suggestions of places to eat, start the flow below immediately with get_location. don't ask them what the options are or where they are first. you never guess where someone is and you never ask them to type their location.
- you can make polls, send voice notes, track their calories, sync what they eat to apple health, and read photos of food (photos are handled automatically).
- you can be added to group chats; say yes if asked. never claim limits you weren't told about.

the food flow, in order:
1. call get_location first (pass any allergies or diets they've mentioned). it checks find my itself: if they're already sharing, it comes straight back with where they are and the nearby restaurants, with no ask at all. only if they aren't sharing does it text them a casual ask, send the find my card and wait for them to tap share (it sends all of that itself, so say nothing before calling it). never ask where they are, or whether they're still at the last place, in text; get_location is the only way you find out. if it comes back not_shared, say something casual like "no worries, tap share on that card whenever and text me again" and stop. if it says already_asked, they already have the card, so just nudge them to tap it (or reply NO_REPLY).
2. then send exactly ONE short text: a quick remark about where they are using place or full_address, like a friend who can see the map ("oh you're right by woodruff park"). never read out coordinates or a full street address. nothing else: the text naming the three spots and the poll to choose between them are sent automatically right after yours, so don't list, name or nudge toward the spots. poll_will_be_sent tells you whether they're going out; if it's false, say why instead. if nearby.far_away is true, say honestly you only know the spots around campus and the closest one is x miles from them. if nearby.none_match_restrictions is true, say there's nothing close that works for that. if they add an allergy or diet later, call nearby_restaurants again.
3. when they type a restaurant instead of tapping the poll, call restaurant_dishes with it, even if it wasn't one of the spots offered. if they said what they're in the mood for, pass it as request. it sends the two dish picks and a poll to choose between them, so reply NO_REPLY after it. (when they tap a poll option the bot handles it by itself, you don't need to do anything.)
4. when they type which dish they want, call pick_dish. it sends a quick reaction and asks if they want directions (as a plain text, not a poll), so reply NO_REPLY after it. the same happens by itself when they tap the dish poll.
5. if they say yes to directions (yeah, sure, yes please), call get_directions. it sends the map link. never send a map link or any url any other way, and never before they say yes. if they say no, just say ok.
the spots and the dish choice go out as polls (the tools send them), so never list those options in text and ask "which one?". directions is a plain yes/no question, never a poll.
if they ask what's good at a specific restaurant without the location part, skip straight to step 3.

allergies and diets: pass every allergy and diet they've mentioned anywhere in the conversation to the tools. never say a dish or restaurant is "safe", "allergen-free" or free of an allergen, and never name anyone's allergies in a group chat. restaurant_dishes adds its own allergy note.

other tools:
- plan_meal: when they ask you to schedule, plan, figure out or set up a meal with other people ("schedule dinner today with ashwani and princy", "i'm gonna grab dinner with x and y, can you figure out the time and place", or a follow-up like "can you text them"). you CAN text people, this tool is how, so never say you can't text them or tell them to message their friends themselves. if they said "my friends" without names, ask who in one short text. you text each of those people separately, work out a time and a place together, and message this person once it's settled. pass the first names as they said them, the meal, and the day (today unless they said tomorrow); if they named a time ("at 7", "around noon"), pass time; if they said any time works, pass anytime true; if they gave a range ("after 7"), pass earliest_hour or latest_hour (24h). if they gave none of those, still call it: it texts them "what time are you thinking?" itself and comes back with asking_time true, so reply with exactly NO_REPLY. otherwise reply with one casual line like "on it, texting ashwani and princy, i'll ping you once it's sorted". if not_found or ambiguous comes back, say who you couldn't find (they have to be added first: share their contact card with you). if it says it's too late, say so and offer tomorrow or the next meal (and when they pick one, call plan_meal again with the same people). only say you're texting people if plan_meal actually came back started; never claim it otherwise.
- create_poll: when the group wants to vote on something. pick 2-5 concrete options yourself if they don't give any. if they ask for a poll about where to eat, that's the food flow above (the spots poll goes out by itself), not create_poll.
- send_voice_note: only when they ask for a voice reply or sent you a voice note.
- log_meal: when they say they ate something ("i had a burrito"). estimate calories, protein_g (always a number), carbs, fat and price. don't log things they're only thinking about. a dish they pick from the poll is already logged and its card sent by pick_dish, so don't log it again.
- show_day / set_goals: how their day is going; their calorie, protein or budget targets. these send a "today's pie" card, so just add a few words.
- when one of those results has a "health" part, it's from their apple health today (calories burned moving around, steps). always say one short thing about it (so not NO_REPLY), like "you've burned about 400 so there's a bit more room". it's an estimate, so keep it loose and don't recite every number.
- connect_health: when they ask to connect, link or sync apple health. it sends the setup steps itself, so reply NO_REPLY after it. if it comes back with an error, tell them that plainly. never write a setup link or steps yourself.
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
      name: "plan_meal",
      description: "Organize a meal with other registered people: texts each one separately to settle a time and a place, then reports back to the person who asked.",
      inputSchema: schema({
        type: "object",
        properties: {
          people: { type: "array", items: { type: "string" }, description: "First names of the people to plan with, as the person said them" },
          meal: { type: "string", enum: ["dinner", "lunch", "breakfast"] },
          day: { type: "string", enum: ["today", "tomorrow"] },
          time: { type: "string", description: "A time they named for the meal ('7', 'around noon', '6:30pm'). Omit if they didn't say one." },
          anytime: { type: "boolean", description: "true only if they said any time is fine ('anytime', 'whenever')." },
          earliest_hour: { type: "integer", description: "Earliest hour (0-23) if they said 'after 7' etc." },
          latest_hour: { type: "integer", description: "Latest hour (0-23) if they gave one" },
        },
        required: ["people", "meal"],
      }),
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
          carbs_g: { type: "number", description: "Estimated grams of carbohydrates" },
          fat_g: { type: "number", description: "Estimated grams of fat" },
          price_usd: { type: "number", description: "Price if known or typical, else 0" },
        },
        required: ["name", "calories", "protein_g", "carbs_g", "fat_g"],
      }),
    },
  },
  {
    toolSpec: {
      name: "connect_health",
      description: "Sends the sender the steps and their private link to sync logged meals to Apple Health.",
      inputSchema: schema({ type: "object", properties: {} }),
    },
  },
  {
    toolSpec: {
      name: "show_day",
      description: "Show the sender's Your day card (calories and protein today, budget left this month).",
      inputSchema: schema({ type: "object", properties: {} }),
    },
  },
  {
    toolSpec: {
      name: "set_goals",
      description: "Set the sender's daily targets. Only pass what they mentioned.",
      inputSchema: schema({
        type: "object",
        properties: { calories: { type: "number" }, protein_g: { type: "number" }, budget_usd: { type: "number", description: "Monthly food budget in dollars" } },
      }),
    },
  },
];

/**
 * A message that's plainly about wanting food always starts with the location check (which itself checks
 * whether Find My is already shared, and only asks if it isn't). Left to the model, it sometimes just
 * asks "where are you at?" in text instead, so the first step is forced in code.
 */
/** "schedule dinner today with ashwani and princy": organizing a meal with other people, not just asking for food. */
const WANTS_PLAN = /\b(schedule|plan|set up|organi[sz]e|arrange|book|line up|figure out)\b.{0,40}\b(dinner|lunch|breakfast|meal|food|eat|brunch)\b.{0,40}\bwith\b/i;
/** "i'm gonna grab dinner with ashwani and princy can you figure out the time and place": a meal with people plus a cue to coordinate it. */
const WANTS_PLAN_COORDINATED =
  /\b(dinner|lunch|breakfast|meal|food|eat|brunch)\b.{0,60}\bwith\b.{0,80}\b(figure out|work out|sort out|time|place|when|where|plan|schedule|set (it|that) up|coordinate|text (them|him|her)|ask (them|him|her)|see what)\b/i;
/** A follow-up like "can you text them and see" after a plan request. */
const PLAN_FOLLOWUP = /\b(text|message|dm|ask|hit up|check with|reach out to|see (what|if|when))\b.{0,25}\b(them|him|her|they|everyone|both)\b/i;
/** "wanna go grab lunch with ash and princy" / "dinner w/ princy?": an invite to eat with named people. */
const WANTS_PLAN_INVITE =
  /\b(wanna|want to|lets?|let's|gonna|going to|can we|should we|how about|down to|trying to|tryna)\b.{0,30}\b(grab|get|go (grab|get|eat|for)|have|do|eat|hit)\b.{0,20}\b(dinner|lunch|breakfast|brunch|food|a bite)\b.{0,12}\b(with|w\/|w)\s+[a-z]/i;
export const wantsPlan = (text: string) => WANTS_PLAN.test(text) || WANTS_PLAN_COORDINATED.test(text) || WANTS_PLAN_INVITE.test(text);
export const planFollowup = (text: string, lastUserText?: string) => !!lastUserText && wantsPlan(lastUserText) && PLAN_FOLLOWUP.test(text);
/** A plan request counts as "the last thing they asked" for follow-ups ("can you text them") only this long. */
const PLAN_DRAFT_TTL = 5 * 60;

const WANTS_FOOD =
  /\b(hungry|starving|famished|hangry|something to eat|place to eat|places to eat|where (should|can|do|to) (i|we|you) (eat|go)|where to eat|what (should|do) (i|we) eat|(wanna|want to|gotta|need to|let'?s|lets) eat|need (some )?food|need (a |some )?(lunch|dinner|breakfast)|grab (some )?(food|lunch|dinner|breakfast|something)|(lunch|dinner|breakfast) (spot|place|ideas?))\b/i;
export const wantsFood = (text: string) => WANTS_FOOD.test(text);

/**
 * Join the text chunks of a reply. The model sometimes returns the same sentence as two chunks (or twice in
 * one), which used to be glued together as "…lmaonah can't…". Drop exact repeats; keep distinct chunks as
 * separate paragraphs (separate texts).
 */
export function replyText(chunks: readonly string[]): string {
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const raw of chunks) {
    const t = raw.trim();
    const key = t.toLowerCase().replace(/\s+/g, " ");
    if (!t || seen.has(key)) continue;
    seen.add(key);
    parts.push(t);
  }
  const joined = parts.join("\n\n");
  // The same text written twice back to back inside one chunk ("A A" or "AA").
  const flat = joined.replace(/\s+/g, " ");
  const half = Math.floor(flat.length / 2);
  if (flat.length > 8 && flat.slice(0, half).trim() === flat.slice(flat.length - half).trim()) return flat.slice(0, half).trim();
  // The model sometimes repeats its last phrase glued on with no space ("...hungry or somethingyou hungry or something").
  const tail = /(.{8,}?)\1$/.exec(flat);
  if (tail && !joined.includes("\n")) return flat.slice(0, flat.length - tail[1]!.length).trim();
  return joined;
}

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

export async function chat(spaceId: string, text: string, runTool: ToolRunner, who?: { name: string }, planNote?: string): Promise<string> {
  const history = await loadHistory(spaceId);
  const turn: Message[] = [{ role: "user", content: [{ text }] }];

  // First step is forced in code for the two messages the model sometimes fumbles: wanting food, and naming a restaurant.
  // The plan request lives in a short-lived key, not in history (which has no timestamps), so a follow-up long after doesn't re-trigger planning.
  if (wantsPlan(text)) await putState(`plandraft#${spaceId}`, text, PLAN_DRAFT_TTL);
  const lastUser = await getState<string>(`plandraft#${spaceId}`);
  const forced = wantsPlan(text) || planFollowup(text, lastUser) ? "plan_meal" : wantsFood(text) ? "get_location" : namesRestaurant(text) ? "restaurant_dishes" : undefined;
  for (let round = 0; ; round++) {
    const res = await client.send(
      new ConverseCommand({
        modelId: modelId(),
        system: [
          { text: SYSTEM },
          // One-on-one chats only. Restrictions come from their saved profile and are applied by the code, not by you.
          // Logistics of a plan this person is in (names, times, who's answered), only while its 5-minute context is open.
          ...(planNote ? [{ text: `a meal plan is in progress that you're coordinating. what's true right now: ${planNote} if they ask about it, answer from this and don't invent details. never mention anyone's allergies, diet or health.` }] : []),
          ...(who ? [{ text: `the person you're texting is ${who.name}, and you know it. if they ask whether you know their name, or what it is, say ${who.name}. any earlier message in this chat saying you don't know their name was from before you knew it; ignore it. use their name now and then, naturally. their saved allergies and diet are already applied to every search, so don't ask about them and don't list them back unless they ask.` }] : []),
        ],
        messages: [...history, ...turn],
        inferenceConfig: { maxTokens: 400, temperature: 0.7 },
        toolConfig: {
          tools: TOOLS,
          ...(round === 0 && forced && { toolChoice: { tool: { name: forced } } }),
        },
      }),
    );
    const message = res.output?.message;
    if (!message) throw new Error("Bedrock returned no message");
    turn.push(message);

    const calls = (message.content ?? []).filter((b) => b.toolUse);
    if (res.stopReason !== "tool_use" || calls.length === 0 || round === MAX_TOOL_ROUNDS) {
      const text = replyText((message.content ?? []).map((b) => b.text ?? ""));
      const usedTools = turn.some((m) => m.content?.some((b) => b.toolResult));
      // The marker only means "nothing to add". If the model wrote real text and also the marker, keep just the text.
      const clean = text.replace(/NO_REPLY/g, "").trim();
      let reply = clean === "" ? (usedTools || text ? NO_REPLY : "huh?") : clean;
      if (reply !== NO_REPLY) reply = await scrubSafetyClaims(reply);
      if (calls.length > 0) turn.pop(); // never store a dangling tool call
      // What we remember saying: the real text when a tool sent it, never the NO_REPLY marker.
      const said = reply === NO_REPLY ? sentTextFrom(turn) ?? "ok" : reply;
      turn.push({ role: "assistant", content: [{ text: said }] });
      await saveHistory(spaceId, [...history, ...turn]);
      return reply;
    }

    const results: ContentBlock[] = [];
    const sentTexts: string[] = [];
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
      const sent = (result as { sent_text?: unknown } | undefined)?.sent_text;
      if (status === "success" && typeof sent === "string") sentTexts.push(sent);
      results.push({ toolResult: { toolUseId: toolUse!.toolUseId, content: [{ json: { result } as any }], status } });
    }
    turn.push({ role: "user", content: results });

    // Every tool this round already sent its message to the chat (dish picks, directions link...). The model has
    // nothing left to add, and left to itself it sometimes repeats what was sent. Skip its follow-up entirely.
    if (sentTexts.length === calls.length) {
      turn.push({ role: "assistant", content: [{ text: sentTexts.join("\n\n") }] });
      await saveHistory(spaceId, [...history, ...turn]);
      return NO_REPLY;
    }
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
