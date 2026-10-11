// Load Photon credentials from AWS Secrets Manager into the env vars spectrum-ts reads.
// The secret is JSON: { projectId, projectSecret, webhookSecret?, elevenlabsApiKey? }. Values already set in the
// environment win (handy for local overrides).
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";

const SECRET_ID = process.env.PHOTON_SECRET_ID ?? "photon/project-secret";
let loaded: Promise<void> | undefined;

export function loadSecrets() {
  return (loaded ??= (async () => {
    if (process.env.SPECTRUM_PROJECT_ID && process.env.SPECTRUM_PROJECT_SECRET && process.env.SPECTRUM_WEBHOOK_SECRET) return;
    const sm = new SecretsManagerClient({ region: process.env.AWS_REGION ?? "us-east-2" });
    const res = await sm.send(new GetSecretValueCommand({ SecretId: SECRET_ID }));
    const { projectId, projectSecret, webhookSecret, elevenlabsApiKey } = JSON.parse(res.SecretString ?? "{}");
    if (!projectId || !projectSecret) throw new Error(`Secret ${SECRET_ID} must contain projectId and projectSecret`);
    process.env.SPECTRUM_PROJECT_ID ??= projectId;
    process.env.SPECTRUM_PROJECT_SECRET ??= projectSecret;
    if (webhookSecret) process.env.SPECTRUM_WEBHOOK_SECRET ??= webhookSecret;
    // Optional: turns on ElevenLabs for speech (and transcription) without putting a key in the Lambda config or in git.
    if (elevenlabsApiKey) process.env.ELEVENLABS_API_KEY ??= elevenlabsApiKey;
    console.log(`loaded Photon credentials from Secrets Manager (${SECRET_ID})`);
  })());
}
