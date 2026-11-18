import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * A synthetic "voice" for Chromium's fake microphone (`--use-file-for-fake-audio-capture`).
 *
 * Chromium's default fake device only beeps (short tones between stretches of digital silence),
 * which the mic check's speech detector rightly does not count as speech: there is no noise floor
 * for the beeps to stand out from. This file has a quiet noise floor with speech-like bursts
 * (noise with a 4 Hz syllable rhythm) and loops, so the real mic check passes. Entirely
 * synthetic: no recorded voice, generated from a fixed seed.
 */
const RATE = 48_000;
const SECONDS = 6;

function synthesise(): Buffer {
  const n = RATE * SECONDS;
  const pcm = Buffer.alloc(n * 2);
  let x = 0x1234567;
  const rand = () => {
    // xorshift32
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return ((x >>> 0) / 4294967296) * 2 - 1;
  };
  const floor = 10 ** (-56 / 20); // ≈ −56 dBFS room noise
  const voice = 10 ** (-16 / 20); // ≈ −16 dBFS (peaks) while "speaking"
  for (let i = 0; i < n; i++) {
    const t = i / RATE;
    // pause for 1 s (the room noise), then speak for 2 s (twice per loop)
    const speaking = t % 3 >= 1;
    const syllable = 0.5 - 0.5 * Math.cos(2 * Math.PI * 4 * t); // 4 Hz envelope
    const amp = floor + (speaking ? voice * (0.25 + 0.75 * syllable) : 0);
    const v = Math.max(-1, Math.min(1, rand() * amp));
    pcm.writeInt16LE(Math.round(v * 32767), i * 2);
  }
  return pcm;
}

function wav(pcm: Buffer): Buffer {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0);
  h.writeUInt32LE(36 + pcm.length, 4);
  h.write("WAVE", 8);
  h.write("fmt ", 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); // PCM
  h.writeUInt16LE(1, 22); // mono
  h.writeUInt32LE(RATE, 24);
  h.writeUInt32LE(RATE * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36);
  h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

/** Path of the synthetic voice file (written once, outside the repo and outside test-results/). */
export function fakeVoiceFile(): string {
  const dir = path.join(os.tmpdir(), "wkwa-e2e");
  const file = path.join(dir, "fake-voice-v1.wav");
  if (!existsSync(file)) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, wav(synthesise()));
  }
  return file;
}
