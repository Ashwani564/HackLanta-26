// Voice notes. ElevenLabs (Scribe STT + TTS) when ELEVENLABS_API_KEY is set; otherwise AWS:
// Amazon Polly for speech and Amazon Transcribe (streaming) for transcripts.
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { ElevenLabsClient } from "@elevenlabs/elevenlabs-js";
import { PollyClient, SynthesizeSpeechCommand, type VoiceId } from "@aws-sdk/client-polly";
import { StartStreamTranscriptionCommand, TranscribeStreamingClient } from "@aws-sdk/client-transcribe-streaming";

const run = promisify(execFile);
const REGION = process.env.AWS_REGION ?? "us-east-2";
const STT_RATE = 16000;

const eleven = process.env.ELEVENLABS_API_KEY
  ? new ElevenLabsClient({ apiKey: process.env.ELEVENLABS_API_KEY })
  : undefined;
// Built-in "Jessica". Library voices (e.g. Rachel 21m00Tcm4TlvDq8ikWAM) return 402 on the free tier.
const VOICE_ID = process.env.ELEVENLABS_VOICE_ID ?? "cgSgspJ2msm6clMCkdW9";
const EL_TTS_MODEL = process.env.ELEVENLABS_TTS_MODEL ?? "eleven_flash_v2_5";
const EL_STT_MODEL = process.env.ELEVENLABS_STT_MODEL ?? "scribe_v2";

const polly = new PollyClient({ region: REGION });
// us-east-2 only offers Polly's "standard" engine; neural/generative voices return an error there.
const POLLY_VOICE = (process.env.POLLY_VOICE_ID ?? "Joanna") as VoiceId;
const POLLY_ENGINE = (process.env.POLLY_ENGINE ?? "standard") as "standard" | "neural" | "generative";
const transcribeClient = new TranscribeStreamingClient({ region: REGION });

/** Audio conversion uses macOS afconvert, so voice notes only work on a Mac host for now
 *  (Lambda would need an ffmpeg layer). */
export const canConvertAudio = () => process.platform === "darwin";

/** Text -> AAC voice note (.m4a). ElevenLabs if configured, else Amazon Polly. */
export async function speak(text: string): Promise<{ audio: Buffer; duration: number }> {
  let mp3: Buffer | undefined;
  if (eleven) {
    try {
      // Raw text only: ElevenLabs would read a tone instruction aloud. Tone comes from the voice.
      // mp3_44100_128 is the highest-quality format the free tier allows (PCM needs a paid plan).
      const stream = await eleven.textToSpeech.convert(VOICE_ID, { text, modelId: EL_TTS_MODEL, outputFormat: "mp3_44100_128" });
      mp3 = Buffer.from(await new Response(stream).arrayBuffer());
    } catch (err) {
      console.warn("  ElevenLabs TTS failed, falling back to Polly:", err);
    }
  }
  if (!mp3) {
    const res = await polly.send(new SynthesizeSpeechCommand({ Text: text, VoiceId: POLLY_VOICE, Engine: POLLY_ENGINE, OutputFormat: "mp3" }));
    mp3 = Buffer.from(await res.AudioStream!.transformToByteArray());
  }
  const audio = await convert(mp3, "in.mp3", ["-f", "m4af", "-d", "aac"], "out.m4a");
  return { audio, duration: await probeDuration(mp3, "in.mp3", text) };
}

/** Any audio Apple can decode (iMessage voice notes are CAF/Opus) -> 16 kHz mono 16-bit WAV. */
export async function toWav(input: Buffer): Promise<Buffer> {
  return convert(input, "in.caf", ["-f", "WAVE", "-d", `LEI16@${STT_RATE}`, "-c", "1"], "out.wav");
}

/** 16 kHz mono WAV (from toWav) -> transcript. ElevenLabs Scribe if configured, else Amazon Transcribe. */
export async function transcribe(wavBuf: Buffer): Promise<string | undefined> {
  if (eleven) {
    try {
      const res = await eleven.speechToText.convert({ file: { data: wavBuf, filename: "voice.wav", contentType: "audio/wav" }, modelId: EL_STT_MODEL });
      const text = res.text?.trim();
      if (text) return text;
    } catch (err) {
      console.warn("  Scribe STT failed, falling back to Amazon Transcribe:", err);
    }
  }
  return transcribeAws(pcmFromWav(wavBuf));
}

async function transcribeAws(pcm: Buffer): Promise<string | undefined> {
  async function* audio() {
    for (let i = 0; i < pcm.length; i += 6400) yield { AudioEvent: { AudioChunk: pcm.subarray(i, i + 6400) } };
  }
  const res = await transcribeClient.send(
    new StartStreamTranscriptionCommand({ LanguageCode: "en-US", MediaEncoding: "pcm", MediaSampleRateHertz: STT_RATE, AudioStream: audio() }),
  );
  const parts: string[] = [];
  for await (const event of res.TranscriptResultStream ?? []) {
    for (const r of event.TranscriptEvent?.Transcript?.Results ?? []) {
      if (!r.IsPartial && r.Alternatives?.[0]?.Transcript) parts.push(r.Alternatives[0].Transcript);
    }
  }
  return parts.join(" ").trim() || undefined;
}

/** Strip the WAV header: find the "data" chunk and return the raw PCM after it. */
function pcmFromWav(wav: Buffer): Buffer {
  let o = 12;
  while (o + 8 <= wav.length) {
    const id = wav.toString("ascii", o, o + 4), size = wav.readUInt32LE(o + 4);
    if (id === "data") return wav.subarray(o + 8, o + 8 + size);
    o += 8 + size + (size % 2);
  }
  return wav.subarray(44);
}

// Seconds of audio in a file afconvert can read, via macOS afinfo. MP3 carries no simple
// byte->duration relationship like raw PCM, so we probe it; estimate from text if afinfo fails.
async function probeDuration(input: Buffer, name: string, text: string): Promise<number> {
  const dir = await mkdtemp(join(tmpdir(), "voice-"));
  try {
    const path = join(dir, name);
    await writeFile(path, input);
    const { stdout } = await run("afinfo", [path]);
    const m = stdout.match(/estimated duration:\s*([\d.]+)/);
    if (m) return parseFloat(m[1]!);
  } catch {
    // fall through to the estimate
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  // ~2.5 words/sec is typical speech; keeps the voice note from showing 0:00.
  return Math.max(1, text.trim().split(/\s+/).length / 2.5);
}

async function convert(input: Buffer, inName: string, args: string[], outName: string) {
  const dir = await mkdtemp(join(tmpdir(), "voice-"));
  try {
    await writeFile(join(dir, inName), input);
    await run("afconvert", [...args, join(dir, inName), join(dir, outName)]);
    return await readFile(join(dir, outName));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
