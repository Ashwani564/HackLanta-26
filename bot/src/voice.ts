import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { GoogleGenAI } from "@google/genai";

const run = promisify(execFile);
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const TTS_MODELS = ["gemini-2.5-flash-preview-tts", "gemini-3.1-flash-tts-preview"];
const SAMPLE_RATE = 24000;

/** Text -> AAC voice note (.m4a) using Gemini TTS and macOS afconvert. */
export async function speak(text: string): Promise<{ audio: Buffer; duration: number }> {
  let pcm: Buffer | undefined;
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
      if (data) {
        pcm = Buffer.from(data, "base64");
        break;
      }
    } catch (err: any) {
      if (err?.status !== 503 && err?.status !== 429) throw err;
    }
  }
  if (!pcm) throw new Error("TTS returned no audio");

  const audio = await convert(wav(pcm), "in.wav", ["-f", "m4af", "-d", "aac"], "out.m4a");
  return { audio, duration: pcm.length / 2 / SAMPLE_RATE };
}

/** Any audio Apple can decode (iMessage voice notes are CAF/Opus) -> WAV that Gemini accepts. */
export async function toWav(input: Buffer): Promise<Buffer> {
  return convert(input, "in.caf", ["-f", "WAVE", "-d", "LEI16"], "out.wav");
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
