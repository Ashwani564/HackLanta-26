import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { GoogleGenAI } from "@google/genai";
import { ElevenLabsClient } from "@elevenlabs/elevenlabs-js";

const run = promisify(execFile);
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const TTS_MODELS = ["gemini-2.5-flash-preview-tts", "gemini-3.1-flash-tts-preview"];
const SAMPLE_RATE = 24000;

// ElevenLabs is primary for audio when a key is present; Gemini is the fallback.
const eleven = process.env.ELEVENLABS_API_KEY
  ? new ElevenLabsClient({ apiKey: process.env.ELEVENLABS_API_KEY })
  : undefined;
const VOICE_ID = process.env.ELEVENLABS_VOICE_ID ?? "21m00Tcm4TlvDq8ikWAM";
const EL_TTS_MODEL = process.env.ELEVENLABS_TTS_MODEL ?? "eleven_flash_v2_5";
const EL_STT_MODEL = process.env.ELEVENLABS_STT_MODEL ?? "scribe_v2";

/** Text -> AAC voice note (.m4a). ElevenLabs TTS (MP3, free tier), falling back to Gemini TTS (PCM). */
export async function speak(text: string): Promise<{ audio: Buffer; duration: number }> {
  if (eleven) {
    try {
      // Raw text only: ElevenLabs would read a tone instruction aloud. Tone comes from the voice.
      // mp3_44100_128 is the highest-quality format the free tier allows (PCM needs a paid plan).
      const stream = await eleven.textToSpeech.convert(VOICE_ID, {
        text,
        modelId: EL_TTS_MODEL,
        outputFormat: "mp3_44100_128",
      });
      const mp3 = Buffer.from(await new Response(stream).arrayBuffer());
      const audio = await convert(mp3, "in.mp3", ["-f", "m4af", "-d", "aac"], "out.m4a");
      return { audio, duration: await probeDuration(mp3, "in.mp3", text) };
    } catch (err) {
      console.warn("  ElevenLabs TTS failed, falling back to Gemini:", err);
    }
  }

  const pcm = await geminiTTS(text);
  const audio = await convert(wav(pcm), "in.wav", ["-f", "m4af", "-d", "aac"], "out.m4a");
  return { audio, duration: pcm.length / 2 / SAMPLE_RATE };
}

/** Voice note -> transcript via ElevenLabs Scribe. Returns undefined (so the caller falls
 *  back to Gemini's native audio understanding) when there's no key or the request fails. */
export async function transcribe(wavBuf: Buffer): Promise<string | undefined> {
  if (!eleven) return undefined;
  try {
    const res = await eleven.speechToText.convert({
      file: { data: wavBuf, filename: "voice.wav", contentType: "audio/wav" },
      modelId: EL_STT_MODEL,
    });
    return res.text?.trim() || undefined;
  } catch (err) {
    console.warn("  Scribe STT failed, falling back to Gemini audio:", err);
    return undefined;
  }
}

/** Gemini TTS -> 24kHz mono 16-bit PCM. Tried in order when a model is overloaded (503/429). */
async function geminiTTS(text: string): Promise<Buffer> {
  for (const model of TTS_MODELS) {
    try {
      const res = await ai.models.generateContent({
        model,
        contents: `Say in a warm, upbeat, casual tone: ${text}`,
        config: {
          responseModalities: ["AUDIO"],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: "Kore" } } },
        },
      });
      const data = res.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
      if (data) return Buffer.from(data, "base64");
    } catch (err: any) {
      if (err?.status !== 503 && err?.status !== 429) throw err;
    }
  }
  throw new Error("TTS returned no audio");
}

/** Any audio Apple can decode (iMessage voice notes are CAF/Opus) -> WAV that Scribe/Gemini accept. */
export async function toWav(input: Buffer): Promise<Buffer> {
  return convert(input, "in.caf", ["-f", "WAVE", "-d", "LEI16"], "out.wav");
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

// 16-bit mono PCM -> WAV container.
function wav(pcm: Buffer): Buffer {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0);
  h.writeUInt32LE(36 + pcm.length, 4);
  h.write("WAVEfmt ", 8);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(SAMPLE_RATE, 24);
  h.writeUInt32LE(SAMPLE_RATE * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36);
  h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}
