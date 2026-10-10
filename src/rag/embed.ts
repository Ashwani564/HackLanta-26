import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";

export const EMBEDDING_DIMENSIONS = 1024;

let client: BedrockRuntimeClient | undefined;

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
}

/** Titan Text Embeddings v2, normalized so cosine distance behaves. Model ID comes from the environment. */
export async function embed(text: string): Promise<number[]> {
  client ??= new BedrockRuntimeClient({ region: process.env.AWS_REGION ?? "us-east-2" });
  const res = await client.send(
    new InvokeModelCommand({
      modelId: requireEnv("EMBEDDING_MODEL_ID"),
      contentType: "application/json",
      accept: "application/json",
      body: JSON.stringify({ inputText: text, dimensions: EMBEDDING_DIMENSIONS, normalize: true }),
    }),
  );
  const body = JSON.parse(new TextDecoder().decode(res.body)) as { embedding?: number[] };
  if (!body.embedding || body.embedding.length !== EMBEDDING_DIMENSIONS) {
    throw new Error(`embedding model returned ${body.embedding?.length ?? 0} dimensions, expected ${EMBEDDING_DIMENSIONS}`);
  }
  return body.embedding;
}

/** Embed many texts with bounded concurrency. Order is preserved. */
export async function embedAll(texts: string[], concurrency = 8): Promise<number[][]> {
  const out: number[][] = new Array(texts.length);
  let next = 0;
  const worker = async () => {
    while (next < texts.length) {
      const i = next++;
      out[i] = await embed(texts[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, texts.length) }, worker));
  return out;
}
