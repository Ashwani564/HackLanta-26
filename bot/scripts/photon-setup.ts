// Photon setup for a fresh AWS project. No secret is ever printed, and unlike rewebhook.sh nothing is deleted
// unless you name it.
//   tsx --env-file=.env scripts/photon-setup.ts secret        type the project id + secret (hidden), store them in Secrets Manager
//   tsx --env-file=.env scripts/photon-setup.ts webhooks      list the project's webhooks (read-only)
//   tsx --env-file=.env scripts/photon-setup.ts register      add the dining-bot Function URL as a webhook, store its signing secret
//   tsx --env-file=.env scripts/photon-setup.ts delete <id>   remove one old webhook, once the new one works
import { createInterface } from "node:readline";
import { GetFunctionUrlConfigCommand, LambdaClient, UpdateFunctionConfigurationCommand } from "@aws-sdk/client-lambda";
import { CreateSecretCommand, GetSecretValueCommand, PutSecretValueCommand, ResourceNotFoundException, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";

const REGION = process.env.AWS_REGION ?? "us-east-2";
const SECRET_ID = process.env.PHOTON_SECRET_ID ?? "photon/project-secret";
const FN = "dining-bot";
const API = "https://spectrum.photon.codes";

const sm = new SecretsManagerClient({ region: REGION });
const lambda = new LambdaClient({ region: REGION });

type Stored = { projectId?: string; projectSecret?: string; webhookSecret?: string; [key: string]: unknown };
type Creds = { projectId: string; projectSecret: string };
type Webhook = { id: string; webhookUrl: string; status?: string; disabledReason?: string | null; createdAt?: string };

async function readSecret(): Promise<Stored | undefined> {
  try {
    const res = await sm.send(new GetSecretValueCommand({ SecretId: SECRET_ID }));
    return JSON.parse(res.SecretString ?? "{}");
  } catch (err) {
    if (err instanceof ResourceNotFoundException) return undefined;
    throw err;
  }
}

async function writeSecret(value: Stored, exists: boolean) {
  const SecretString = JSON.stringify(value);
  if (exists) await sm.send(new PutSecretValueCommand({ SecretId: SECRET_ID, SecretString }));
  else await sm.send(new CreateSecretCommand({ Name: SECRET_ID, SecretString }));
}

async function storedCreds(): Promise<{ stored: Stored; creds: Creds }> {
  const stored = await readSecret();
  if (!stored?.projectId || !stored.projectSecret) throw new Error(`${SECRET_ID} has no projectId/projectSecret yet. run: photon-setup.ts secret`);
  return { stored, creds: { projectId: stored.projectId, projectSecret: stored.projectSecret } };
}

async function photon(c: Creds, method: string, path = "", body?: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`${API}/projects/${c.projectId}/webhooks/${path}`, {
    method,
    headers: {
      authorization: "Basic " + Buffer.from(`${c.projectId}:${c.projectSecret}`).toString("base64"),
      ...(body !== undefined && { "content-type": "application/json" }),
    },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

/** A response with every secret-looking field removed, safe to print. */
const redact = (value: unknown) => JSON.stringify(value, (key, v) => (/secret/i.test(key) ? "<hidden>" : v));

async function listWebhooks(c: Creds): Promise<Webhook[]> {
  const { status, json } = await photon(c, "GET");
  if (status !== 200 || !Array.isArray(json?.data)) throw new Error(`Photon refused the list (HTTP ${status}): ${redact(json)}`);
  return json.data;
}

const show = (hooks: Webhook[], mine?: string) =>
  hooks.length === 0
    ? console.log("  (none)")
    : hooks.forEach((h) => console.log(`  ${h.id}  ${h.status ?? "?"}${h.disabledReason ? ` (${h.disabledReason})` : ""}  ${h.webhookUrl}${h.webhookUrl === mine ? "   <- this deployment" : ""}`));

function ask(question: string, hidden = false): Promise<string> {
  if (hidden && !process.stdin.isTTY) throw new Error("run this in PowerShell or Windows Terminal, so the secret can be typed without showing");
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      if (hidden) process.stdout.write("\n");
      resolve(answer.trim());
    });
    // The question is already on screen; from here on nothing typed or pasted is echoed.
    if (hidden) (rl as any)._writeToOutput = () => {};
  });
}

async function functionUrl(): Promise<string> {
  const res = await lambda.send(new GetFunctionUrlConfigCommand({ FunctionName: FN }));
  if (!res.FunctionUrl) throw new Error(`${FN} has no Function URL. deploy the stack first`);
  return res.FunctionUrl;
}

const [command, arg] = process.argv.slice(2);
console.log(`region ${REGION}, secret ${SECRET_ID}`);

switch (command) {
  case "secret": {
    const existing = await readSecret();
    const projectId = await ask("Photon project id: ");
    const projectSecret = await ask("Photon project secret (hidden): ", true);
    if (!projectId || !projectSecret) throw new Error("both are needed");
    // Read-only call, to catch a typo before anything is stored.
    const hooks = await listWebhooks({ projectId, projectSecret });
    await writeSecret({ ...existing, projectId, projectSecret }, !!existing);
    console.log(`Photon accepted the credentials (${hooks.length} webhook(s) registered). saved in ${SECRET_ID}`);
    break;
  }
  case "webhooks": {
    const { creds } = await storedCreds();
    show(await listWebhooks(creds), await functionUrl().catch(() => undefined));
    break;
  }
  case "register": {
    const { stored, creds } = await storedCreds();
    const url = await functionUrl();
    const before = await listWebhooks(creds);
    console.log("existing webhooks (left as they are):");
    show(before, url);
    if (before.some((h) => h.webhookUrl === url && h.status !== "disabled")) {
      throw new Error("this URL is already registered and Photon shows a signing secret only once. if deliveries are rejected as \"bad signature\", delete that webhook by id and register again");
    }
    const { status, json } = await photon(creds, "POST", "", { webhookUrl: url });
    if (json?.succeed !== true || !json.data?.signingSecret) throw new Error(`register failed (HTTP ${status}): ${redact(json)}`);
    await writeSecret({ ...stored, webhookSecret: json.data.signingSecret }, true);
    console.log(`registered ${json.data.id} -> ${json.data.webhookUrl}`);
    console.log(`saved its signing secret as webhookSecret in ${SECRET_ID}`);
    // A config change recycles the Lambda's warm containers, which cached the secret they loaded at startup.
    await lambda.send(new UpdateFunctionConfigurationCommand({ FunctionName: FN, Description: `webhook registered ${new Date().toISOString()}` }));
    console.log(`restarted ${FN}. text the bot now.`);
    break;
  }
  case "delete": {
    if (!arg) throw new Error("usage: photon-setup.ts delete <webhook id>");
    const { creds } = await storedCreds();
    const { status, json } = await photon(creds, "DELETE", `${arg}/`);
    if (status !== 200) throw new Error(`delete failed (HTTP ${status}): ${redact(json)}`);
    console.log(`deleted ${arg}`);
    break;
  }
  default:
    console.log("usage: photon-setup.ts secret | webhooks | register | delete <webhook id>");
    process.exitCode = 1;
}
