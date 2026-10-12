// One place that talks to the model. With BEDROCK_MODEL_ID set (and LLM_PROVIDER not "free") it is Amazon Bedrock.
// Otherwise every call goes to a free OpenAI-compatible endpoint (Pollinations by default, no key needed), so the
// bot runs with no AWS at all. Free endpoints are rate-limited per IP, so calls are queued one at a time and retried.
import { ConverseCommand, type BedrockRuntimeClient, type ConverseCommandInput, type ConverseCommandOutput, type ContentBlock } from "@aws-sdk/client-bedrock-runtime";

const FREE_URL = () => process.env.FREE_LLM_URL ?? "https://text.pollinations.ai/openai";
const FREE_MODEL = () => process.env.FREE_LLM_MODEL ?? "openai-fast";
const MIN_GAP_MS = () => Number(process.env.FREE_LLM_MIN_GAP_MS ?? 20000);

export const usingFreeLlm = () => process.env.LLM_PROVIDER === "free" || !process.env.BEDROCK_MODEL_ID;

type OpenAiMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[] }
  | { role: "tool"; tool_call_id: string; content: string };

/** Bedrock Converse messages to OpenAI chat messages (tool results become their own "tool" messages). */
export function toOpenAiMessages(input: Pick<ConverseCommandInput, "system" | "messages">): OpenAiMessage[] {
  const out: OpenAiMessage[] = [];
  const system = (input.system ?? []).map((s) => s.text ?? "").filter(Boolean).join("\n\n");
  if (system) out.push({ role: "system", content: system });
  for (const m of input.messages ?? []) {
    const blocks: ContentBlock[] = m.content ?? [];
    const text = blocks.map((b) => b.text ?? "").filter((t) => t !== "").join("\n\n");
    if (m.role === "assistant") {
      const calls = blocks.filter((b) => b.toolUse).map((b) => ({
        id: b.toolUse!.toolUseId!,
        type: "function" as const,
        function: { name: b.toolUse!.name!, arguments: JSON.stringify(b.toolUse!.input ?? {}) },
      }));
      out.push({ role: "assistant", content: text || null, ...(calls.length > 0 && { tool_calls: calls }) });
    } else {
      for (const b of blocks) {
        if (!b.toolResult) continue;
        const parts = (b.toolResult.content ?? []).map((c) => (c.json !== undefined ? JSON.stringify(c.json) : c.text ?? ""));
        out.push({ role: "tool", tool_call_id: b.toolResult.toolUseId!, content: parts.join("\n") || "{}" });
      }
      if (text) out.push({ role: "user", content: text });
    }
  }
  return out;
}

/** Turn an OpenAI chat completion choice back into a Converse-shaped response. */
export function fromOpenAiChoice(c: { message?: { content?: string | null; tool_calls?: { id: string; function: { name: string; arguments: string } }[] }; finish_reason?: string }): ConverseCommandOutput {
  const content: ContentBlock[] = [];
  if (c.message?.content) content.push({ text: c.message.content });
  for (const call of c.message?.tool_calls ?? []) {
    let args: unknown = {};
    try {
      args = JSON.parse(call.function.arguments || "{}");
    } catch {
      /* a model that wrote broken JSON gets an empty call; the tool validates its own input */
    }
    content.push({ toolUse: { toolUseId: call.id, name: call.function.name, input: args as never } });
  }
  const stopReason = (c.message?.tool_calls?.length ?? 0) > 0 ? "tool_use" : c.finish_reason === "length" ? "max_tokens" : "end_turn";
  return { output: { message: { role: "assistant", content } }, stopReason, $metadata: {} } as ConverseCommandOutput;
}

// Free endpoints allow roughly one request per IP every ~15-20 s: run calls one at a time, spaced out.
let queue: Promise<unknown> = Promise.resolve();
let lastCall = 0;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function freeCall(input: ConverseCommandInput, fetchImpl: typeof fetch): Promise<ConverseCommandOutput> {
  const tools = (input.toolConfig?.tools ?? []).filter((t) => t.toolSpec).map((t) => ({
    type: "function" as const,
    function: {
      name: t.toolSpec!.name!,
      description: t.toolSpec!.description ?? "",
      parameters: (t.toolSpec!.inputSchema as { json?: unknown } | undefined)?.json ?? { type: "object", properties: {} },
    },
  }));
  const choice = input.toolConfig?.toolChoice;
  const tool_choice = choice?.tool ? { type: "function", function: { name: choice.tool.name } } : choice?.any ? "required" : "auto";
  let withTools = tools.length > 0;
  const body = () =>
    JSON.stringify({
      model: FREE_MODEL(),
      messages: toOpenAiMessages(input),
      max_tokens: Math.max(input.inferenceConfig?.maxTokens ?? 400, 600), // reasoning models spend tokens before answering
      temperature: input.inferenceConfig?.temperature ?? 0.7,
      ...(withTools && { tools, tool_choice }),
    });
  for (let attempt = 0; ; attempt++) {
    const wait = lastCall + MIN_GAP_MS() - Date.now();
    if (wait > 0) await sleep(wait);
    let res: Response;
    try {
      res = await fetchImpl(FREE_URL(), {
        method: "POST",
        headers: { "content-type": "application/json", ...(process.env.FREE_LLM_API_KEY && { authorization: `Bearer ${process.env.FREE_LLM_API_KEY}` }) },
        body: body(),
      });
    } finally {
      lastCall = Date.now(); // the limit counts from when the last answer finished
    }
    if (res.ok) {
      const data = (await res.json()) as { choices?: Parameters<typeof fromOpenAiChoice>[0][] };
      const c = data.choices?.[0];
      if (!c?.message) throw new Error("free LLM returned no message");
      // Small models sometimes emit a made-up tool name ("NO_REPLY<|channel|>commentary"): keep only real tools.
      const known = new Set(tools.map((t) => t.function.name));
      if (c.message.tool_calls) c.message.tool_calls = c.message.tool_calls.filter((t) => known.has(t.function?.name));
      // Nothing usable (empty text, only bogus tool calls): ask once more without tools, for a plain answer.
      if (!c.message.content?.trim() && !c.message.tool_calls?.length && withTools && !choice?.tool && attempt < 3) {
        withTools = false;
        continue;
      }
      return fromOpenAiChoice(c);
    }
    // 402/429 is the free tier's rate limit: wait and try again a few times.
    if ((res.status === 402 || res.status === 429 || res.status >= 500) && attempt < 3) {
      console.warn(`  free LLM busy (${res.status}), retrying`);
      await sleep(MIN_GAP_MS());
      continue;
    }
    throw new Error(`free LLM ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
}

/** Ask the model. Bedrock when configured, the free endpoint otherwise. */
export async function converse(client: BedrockRuntimeClient | undefined, input: ConverseCommandInput, fetchImpl: typeof fetch = fetch): Promise<ConverseCommandOutput> {
  if (!usingFreeLlm() && client) return client.send(new ConverseCommand(input));
  const run = queue.then(() => freeCall(input, fetchImpl));
  queue = run.catch(() => {});
  return run;
}
