import {
  BedrockRuntimeClient,
  ConverseCommand,
  type ToolInputSchema,
} from "@aws-sdk/client-bedrock-runtime";

let client: BedrockRuntimeClient | undefined;

/**
 * Ask the model to answer by calling one tool, so the output is structured JSON and not prose.
 * The caller must still validate the returned object. The model ID comes from BEDROCK_MODEL_ID.
 */
export async function converseTool<T>(opts: {
  system: string;
  user: string;
  toolName: string;
  toolDescription: string;
  schema: Record<string, unknown>;
  maxTokens?: number;
}): Promise<T> {
  const modelId = process.env.BEDROCK_MODEL_ID;
  if (!modelId) throw new Error("BEDROCK_MODEL_ID is not set");
  client ??= new BedrockRuntimeClient({ region: process.env.AWS_REGION ?? "us-east-2" });

  const res = await client.send(
    new ConverseCommand({
      modelId,
      system: [{ text: opts.system }],
      messages: [{ role: "user", content: [{ text: opts.user }] }],
      inferenceConfig: { maxTokens: opts.maxTokens ?? 600, temperature: 0 },
      toolConfig: {
        tools: [
          {
            toolSpec: {
              name: opts.toolName,
              description: opts.toolDescription,
              inputSchema: { json: opts.schema } as ToolInputSchema,
            },
          },
        ],
        toolChoice: { tool: { name: opts.toolName } },
      },
    }),
  );

  const block = res.output?.message?.content?.find((b) => b.toolUse?.name === opts.toolName);
  if (!block?.toolUse) throw new Error("model did not return the requested tool call");
  return block.toolUse.input as T;
}
