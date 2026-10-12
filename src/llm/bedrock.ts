import { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";
import { converse, usingFreeLlm } from "./converse.js";

let client: BedrockRuntimeClient | undefined;

/** The first {...} object in a text reply, for free models that answer in prose instead of calling the tool. */
function jsonIn(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return undefined;
  }
}

/**
 * Ask the model to answer by calling one tool, so the output is structured JSON and not prose.
 * The caller must still validate the returned object. Bedrock (BEDROCK_MODEL_ID) or the free LLM (see converse.ts).
 */
export async function converseTool<T>(opts: {
  system: string;
  user: string;
  toolName: string;
  toolDescription: string;
  schema: Record<string, unknown>;
  maxTokens?: number;
}): Promise<T> {
  if (!usingFreeLlm()) client ??= new BedrockRuntimeClient({ region: process.env.AWS_REGION ?? "us-east-2" });

  const res = await converse(client, {
    modelId: process.env.BEDROCK_MODEL_ID ?? "free",
    system: [{ text: usingFreeLlm() ? `${opts.system}\n\nAnswer by calling ${opts.toolName}. If you can't call tools, reply with only a JSON object matching its parameters.` : opts.system }],
    messages: [{ role: "user", content: [{ text: opts.user }] }],
    inferenceConfig: { maxTokens: opts.maxTokens ?? 600, temperature: 0 },
    toolConfig: {
      tools: [{ toolSpec: { name: opts.toolName, description: opts.toolDescription, inputSchema: { json: opts.schema as never } } }],
      toolChoice: { tool: { name: opts.toolName } },
    },
  });

  const content = res.output?.message?.content ?? [];
  const block = content.find((b) => b.toolUse?.name === opts.toolName);
  if (block?.toolUse) return block.toolUse.input as T;
  const parsed = jsonIn(content.map((b) => b.text ?? "").join(""));
  if (parsed && typeof parsed === "object") return parsed as T;
  throw new Error("model did not return the requested tool call");
}
