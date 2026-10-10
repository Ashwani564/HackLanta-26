import { GoogleGenAI, Type, type Content, type FunctionDeclaration, type Part } from "@google/genai";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
// Fast non-thinking models, tried in order when one is overloaded (503/429).
const MODELS = (process.env.GEMINI_MODEL ?? "gemini-2.5-flash,gemini-3.1-flash-lite").split(",");

const SYSTEM = `You are a friendly dining assistant texting over iMessage.
Help people decide what to eat based on their diet, allergies, calorie/protein goals, and budget.
Always reply in ONE short line (under 25 words). No markdown, no lists.
Label nutrition numbers as estimates.
You can be added to iMessage group chats; say yes if asked. Never claim limits you aren't told about.
Tools:
- create_poll: when someone wants the group to vote (e.g. where to eat). Pick 2-5 concrete options yourself if they don't give any.
- send_voice_note: only when they ask for a voice note/voice reply or sent you a voice note. Your text reply is still sent too, so keep it short.
- get_location: when they ask for places near them or where they are. If it says a request was sent, tell them to accept the Find My request and ask again.
- log_meal: when they ate/are eating something (a food photo of their meal, or "I had X"). Estimate calories, protein and price. Don't log menus or things they're only considering.
- show_day: when they ask how their day/calories/budget is going.
- set_goals: when they tell you their calorie, protein or budget targets.
log_meal, show_day and set_goals show a "Your day" card automatically; mention what's left in your reply.
After a tool runs, don't announce it ("I'll send a poll"); the user already sees it. Add a short natural line instead.`;

export const PHOTO_PROMPT = `Look at this photo and estimate nutrition.
- If it's food or a meal: name the dish and give estimated calories and protein for the visible portion.
  Format: "<dish>: ~<cal> cal, ~<g>g protein (est.)" then a few words of advice.
  Also call log_meal with those estimates (it's what I'm eating).
- If it's a menu: pick the best 1-2 dishes for me with estimated calories each.
- If it's neither: say what you see in a few words and ask for a food or menu photo.
Keep it to one or two short lines. No markdown.`;

export const VOICE_PROMPT = "This is my voice note. Respond to what I said, and reply with a voice note.";

// Used when Scribe transcribed the voice note for us; signals "a voice note arrived" so the
// model still triggers send_voice_note, while responding to the transcribed text.
export const VOICE_TRANSCRIPT_PROMPT = "I sent you a voice note. Respond to what I said, and reply with a voice note. Transcript:";

const TOOLS: FunctionDeclaration[] = [
  {
    name: "create_poll",
    description: "Send an iMessage poll into this chat.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        question: { type: Type.STRING, description: "Short poll title" },
        options: { type: Type.ARRAY, items: { type: Type.STRING }, description: "2-5 choices" },
      },
      required: ["question", "options"],
    },
  },
  {
    name: "send_voice_note",
    description: "Send a spoken voice note into this chat.",
    parameters: {
      type: Type.OBJECT,
      properties: { text: { type: Type.STRING, description: "What to say, 1-3 sentences" } },
      required: ["text"],
    },
  },
  {
    name: "log_meal",
    description: "Log a meal the sender ate today and update their Your day card.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        name: { type: Type.STRING, description: "Dish name" },
        calories: { type: Type.NUMBER, description: "Estimated kcal" },
        protein_g: { type: Type.NUMBER, description: "Estimated grams of protein" },
        price_usd: { type: Type.NUMBER, description: "Price if known or typical, else 0" },
      },
      required: ["name", "calories", "protein_g"],
    },
  },
  {
    name: "show_day",
    description: "Show the sender's Your day card (calories, protein, budget left today).",
  },
  {
    name: "set_goals",
    description: "Set the sender's daily targets. Only pass what they mentioned.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        calories: { type: Type.NUMBER },
        protein_g: { type: Type.NUMBER },
        budget_usd: { type: Type.NUMBER },
      },
    },
  },
  {
    name: "get_location",
    description:
      "Get the sender's current location via Find My. Sends a sharing request card if they aren't sharing yet.",
  },
];

export type ToolRunner = (name: string, args: Record<string, any>) => Promise<unknown>;

// Short rolling history per conversation, kept in memory.
const histories = new Map<string, Content[]>();
const MAX_TURNS = 20;
const MAX_TOOL_ROUNDS = 3;

export async function chat(spaceId: string, parts: Part[], runTool: ToolRunner): Promise<string> {
  const history = histories.get(spaceId) ?? [];
  const turn: Content[] = [{ role: "user", parts }];

  for (let round = 0; ; round++) {
    const res = await generate([...history, ...turn]);
    const calls = res.functionCalls ?? [];
    if (calls.length === 0 || round === MAX_TOOL_ROUNDS) {
      const reply = res.text?.trim() || "Done!";
      turn.push({ role: "model", parts: [{ text: reply }] });
      histories.set(spaceId, trim([...history, ...turn]));
      return reply;
    }

    turn.push(res.candidates![0]!.content!);
    const responses: Part[] = [];
    for (const call of calls) {
      console.log(`  tool ${call.name} ${JSON.stringify(call.args ?? {})}`);
      let result: unknown;
      try {
        result = await runTool(call.name!, call.args ?? {});
      } catch (err: any) {
        console.error(`  tool ${call.name} failed:`, err);
        result = { error: err?.message ?? String(err) };
      }
      responses.push({ functionResponse: { id: call.id, name: call.name, response: { result } } });
    }
    turn.push({ role: "user", parts: responses });
  }
}

async function generate(contents: Content[]) {
  let lastErr: unknown;
  for (const model of MODELS) {
    try {
      return await ai.models.generateContent({
        model,
        contents,
        config: {
          systemInstruction: SYSTEM,
          tools: [{ functionDeclarations: TOOLS }],
          // Thinking adds 30s+ of latency; short texts don't need it.
          thinkingConfig: { thinkingBudget: 0 },
        },
      });
    } catch (err: any) {
      lastErr = err;
      if (err?.status !== 503 && err?.status !== 429) throw err;
      console.warn(`  ${model} unavailable (${err.status}), trying next model`);
    }
  }
  throw lastErr;
}

// Keep the last MAX_TURNS entries, starting on a real user message so a
// function call is never separated from its response.
function trim(history: Content[]): Content[] {
  let start = Math.max(0, history.length - MAX_TURNS);
  while (start < history.length) {
    const h = history[start]!;
    if (h.role === "user" && !h.parts?.some((p) => p.functionResponse)) break;
    start++;
  }
  return history.slice(start);
}

export function reset(spaceId: string) {
  histories.delete(spaceId);
}
