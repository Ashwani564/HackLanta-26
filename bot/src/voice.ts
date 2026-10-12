// Voice notes. VOICE_ENGINE=local (the default with LLM_PROVIDER=free): free and offline, espeak-ng (or macOS `say`)
// for speech and whisper.cpp for transcripts. Otherwise ElevenLabs (Scribe STT + TTS) when ELEVENLABS_API_KEY is set,
// and AWS (Amazon Polly, Amazon Transcribe) as the fallback.
import { execFile, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
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

// Built on first use, not at import: on Lambda the key arrives from Secrets Manager after this module loads.
let elevenClient: ElevenLabsClient | undefined;
let elevenKey: string | undefined;
/** Free, offline voice: no account, no key, no network. */
export const localVoice = () => (process.env.VOICE_ENGINE ?? (process.env.LLM_PROVIDER === "free" ? "local" : "")) === "local";
const eleven = (): ElevenLabsClient | undefined => {
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key || localVoice()) return undefined;
  if (!elevenClient || elevenKey !== key) {
    elevenClient = new ElevenLabsClient({ apiKey: key });
    elevenKey = key;
  }
  return elevenClient;
};
/** True when voice goes through ElevenLabs (the key is set); otherwise Amazon Polly and Transcribe. */
export const elevenLabsEnabled = () => !!process.env.ELEVENLABS_API_KEY && !localVoice();
let warnedNoKey = false;
// Built-in "Jessica". Library voices (e.g. Rachel 21m00Tcm4TlvDq8ikWAM) return 402 on the free tier.
const VOICE_ID = process.env.ELEVENLABS_VOICE_ID ?? "cgSgspJ2msm6clMCkdW9";
const EL_TTS_MODEL = process.env.ELEVENLABS_TTS_MODEL ?? "eleven_flash_v2_5";
const EL_STT_MODEL = process.env.ELEVENLABS_STT_MODEL ?? "scribe_v2";

const polly = new PollyClient({ region: REGION });
// us-east-2 only offers Polly's "standard" engine; neural/generative voices return an error there.
const POLLY_VOICE = (process.env.POLLY_VOICE_ID ?? "Joanna") as VoiceId;
const POLLY_ENGINE = (process.env.POLLY_ENGINE ?? "standard") as "standard" | "neural" | "generative";
const transcribeClient = new TranscribeStreamingClient({ region: REGION });

// Audio conversion uses ffmpeg: from the Lambda layer (/opt/bin/ffmpeg), FFMPEG_PATH, or the PATH. macOS's
// afconvert is only a fallback for a Mac without ffmpeg. Using ffmpeg everywhere means what we test locally
// is what runs on Lambda.
const FFMPEG = process.env.FFMPEG_PATH ?? (existsSync("/opt/bin/ffmpeg") ? "/opt/bin/ffmpeg" : "ffmpeg");
let ffmpegOk: boolean | undefined;
const hasFfmpeg = () => {
  if (ffmpegOk === undefined) {
    try {
      execFileSync(FFMPEG, ["-version"], { stdio: "ignore" });
      ffmpegOk = true;
    } catch {
      ffmpegOk = false;
    }
  }
  return ffmpegOk;
};
export const canConvertAudio = () => hasFfmpeg() || process.platform === "darwin";

/** Text -> AAC voice note (.m4a). Spoken by ElevenLabs; Amazon Polly only if ElevenLabs isn't set up or the call fails. */
export async function speak(text: string): Promise<{ audio: Buffer; duration: number }> {
  if (localVoice()) {
    const { audio: raw, name } = await speakLocal(text);
    const audio = await convert(raw, name, { ff: ["-c:a", "aac", "-b:a", "64k", "-ac", "1"], af: ["-f", "m4af", "-d", "aac"] }, "out.m4a");
    return { audio, duration: await probeDuration(raw, name, text) };
  }
  let mp3: Buffer | undefined;
  const el = eleven();
  if (el) {
    try {
      // Raw text only: ElevenLabs would read a tone instruction aloud. Tone comes from the voice.
      // mp3_44100_128 is the highest-quality format the free tier allows (PCM needs a paid plan).
      const stream = await el.textToSpeech.convert(VOICE_ID, { text, modelId: EL_TTS_MODEL, outputFormat: "mp3_44100_128" });
      mp3 = Buffer.from(await new Response(stream).arrayBuffer());
      console.log(`  voice: spoke ${text.length} chars with ElevenLabs (${EL_TTS_MODEL})`);
    } catch (err) {
      console.warn("  ElevenLabs TTS failed, falling back to Polly:", err);
    }
  } else if (!warnedNoKey) {
    warnedNoKey = true;
    console.warn("  voice: ELEVENLABS_API_KEY isn't set, so speech uses Amazon Polly");
  }
  if (!mp3) {
    // No-AWS mode (npm run start:free): never fall back to Amazon; the caller replies in text instead.
    if (process.env.LLM_PROVIDER === "free") throw new Error("ElevenLabs is unavailable and AWS is off");
    const res = await polly.send(new SynthesizeSpeechCommand({ Text: text, VoiceId: POLLY_VOICE, Engine: POLLY_ENGINE, OutputFormat: "mp3" }));
    mp3 = Buffer.from(await res.AudioStream!.transformToByteArray());
  }
  // AAC in an .m4a is what iMessage plays as a voice message.
  const audio = await convert(mp3, "in.mp3", { ff: ["-c:a", "aac", "-b:a", "64k", "-ac", "1"], af: ["-f", "m4af", "-d", "aac"] }, "out.m4a");
  return { audio, duration: await probeDuration(mp3, "in.mp3", text) };
}

/** Any audio Apple can decode (iMessage voice notes are CAF/Opus) -> 16 kHz mono 16-bit WAV. */
export async function toWav(input: Buffer): Promise<Buffer> {
  return convert(input, "in.caf", { ff: ["-ar", String(STT_RATE), "-ac", "1", "-c:a", "pcm_s16le", "-f", "wav"], af: ["-f", "WAVE", "-d", `LEI16@${STT_RATE}`, "-c", "1"] }, "out.wav");
}

/** 16 kHz mono WAV (from toWav) -> transcript. ElevenLabs Scribe if configured, else Amazon Transcribe. */
export async function transcribe(wavBuf: Buffer): Promise<string | undefined> {
  if (localVoice()) return transcribeLocal(wavBuf);
  const el = eleven();
  if (el) {
    try {
      const res = await el.speechToText.convert({ file: { data: wavBuf, filename: "voice.wav", contentType: "audio/wav" }, modelId: EL_STT_MODEL });
      const text = res.text?.trim();
      if (text) return text;
    } catch (err) {
      console.warn("  Scribe STT failed, falling back to Amazon Transcribe:", err);
    }
  }
  if (process.env.LLM_PROVIDER === "free") return undefined; // no-AWS mode: no Amazon Transcribe fallback
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

const ESPEAK = process.env.ESPEAK_PATH ?? "espeak-ng";
const WHISPER = process.env.WHISPER_BIN ?? "whisper-cli";
const WHISPER_MODEL = process.env.WHISPER_MODEL ?? "/opt/whisper/ggml-tiny.en.bin";

/** Offline text-to-speech: espeak-ng where it's installed (the Docker image), macOS `say` on a Mac. */
async function speakLocal(text: string): Promise<{ audio: Buffer; name: string }> {
  const dir = await mkdtemp(join(tmpdir(), "voice-"));
  try {
    try {
      const out = join(dir, "speech.wav");
      await run(ESPEAK, ["-v", process.env.ESPEAK_VOICE ?? "en-us", "-s", "165", "-w", out, text]);
      console.log(`  voice: spoke ${text.length} chars with espeak-ng`);
      return { audio: await readFile(out), name: "speech.wav" };
    } catch (err) {
      if (process.platform !== "darwin") throw err;
      const out = join(dir, "speech.aiff");
      await run("say", ["-o", out, text]);
      console.log(`  voice: spoke ${text.length} chars with macOS say`);
      return { audio: await readFile(out), name: "speech.aiff" };
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Offline speech-to-text with whisper.cpp (16 kHz mono WAV in). Undefined if it isn't installed. */
async function transcribeLocal(wavBuf: Buffer): Promise<string | undefined> {
  if (!existsSync(WHISPER_MODEL)) {
    console.warn(`  voice: no whisper model at ${WHISPER_MODEL}, can't transcribe`);
    return undefined;
  }
  const dir = await mkdtemp(join(tmpdir(), "voice-"));
  try {
    const path = join(dir, "in.wav");
    await writeFile(path, wavBuf);
    const { stdout } = await run(WHISPER, ["-m", WHISPER_MODEL, "-f", path, "-l", "en", "-nt", "-np", "-t", process.env.WHISPER_THREADS ?? "2"], { timeout: 120_000 });
    const text = stdout.replace(/\[[^\]]*\]|\([^)]*\)/g, " ").replace(/\s+/g, " ").trim();
    console.log(`  voice: transcribed with whisper.cpp: "${text}"`);
    return text || undefined;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
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

// Seconds of audio in a file, read from ffmpeg (or macOS afinfo). MP3 has no simple byte->duration relationship,
// so probe it; estimate from the text if neither tool can.
async function probeDuration(input: Buffer, name: string, text: string): Promise<number> {
  const dir = await mkdtemp(join(tmpdir(), "voice-"));
  try {
    const path = join(dir, name);
    await writeFile(path, input);
    if (hasFfmpeg()) {
      // `ffmpeg -i file` with no output exits non-zero but prints "Duration: 00:00:03.15" on stderr.
      const err = await run(FFMPEG, ["-hide_banner", "-i", path]).then(() => "", (e) => String(e?.stderr ?? ""));
      const m = err.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
      if (m) return Number(m[1]) * 3600 + Number(m[2]) * 60 + parseFloat(m[3]!);
    } else {
      const { stdout } = await run("afinfo", [path]);
      const m = stdout.match(/estimated duration:\s*([\d.]+)/);
      if (m) return parseFloat(m[1]!);
    }
  } catch {
    // fall through to the estimate
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  // ~2.5 words/sec is typical speech; keeps the voice note from showing 0:00.
  return Math.max(1, text.trim().split(/\s+/).length / 2.5);
}

async function convert(input: Buffer, inName: string, args: { ff: string[]; af: string[] }, outName: string) {
  const dir = await mkdtemp(join(tmpdir(), "voice-"));
  try {
    const inPath = join(dir, inName), outPath = join(dir, outName);
    await writeFile(inPath, input);
    if (hasFfmpeg()) await run(FFMPEG, ["-y", "-loglevel", "error", "-i", inPath, ...args.ff, outPath]);
    else await run("afconvert", [...args.af, inPath, outPath]);
    return await readFile(outPath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
