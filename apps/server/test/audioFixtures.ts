import { randomUUID } from "node:crypto";
import type { AudioFileStore } from "../src/audio/fileStore";
import type { Store } from "../src/db/store";
import { nowTs } from "../src/runtime";

export const SAMPLE_RATE = 16_000;

/**
 * Synthetic 16 kHz mono s16le PCM: a 440 Hz tone whose loudness depends on
 * `seed`, with a stretch of digital silence in the middle (a recognisable
 * plaintext pattern for the encryption-at-rest checks).
 */
export function pcmChunk(samples: number, seed = 0): Buffer {
  const buf = Buffer.alloc(samples * 2);
  const amp = 4000 + (seed % 7) * 1000;
  for (let i = 0; i < samples; i++) {
    const silent = i > samples / 3 && i < samples / 2;
    const v = silent
      ? 0
      : Math.round(amp * Math.sin((2 * Math.PI * 440 * (i + seed * samples)) / SAMPLE_RATE));
    buf.writeInt16LE(v, i * 2);
  }
  return buf;
}

export interface TestTrack {
  trackId: string;
  fileName: string;
  key: Buffer;
  pcm: Buffer[];
}

/** A track with `chunks` chunks of `samples` samples each, written the way the live path will. */
export async function addTrack(
  store: Store,
  files: AudioFileStore,
  sessionId: string,
  seat: number,
  participantCode: string,
  chunks = 3,
  samples = 1600,
): Promise<TestTrack> {
  const trackId = randomUUID();
  const { fileName, key } = await files.createFile(sessionId);
  const t0 = nowTs();
  store.insertAudioTrack({
    trackId,
    sessionId,
    seat,
    participantCode,
    fileName,
    fileKey: key,
    sampleRate: SAMPLE_RATE,
    settings: {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      sampleRate: 48_000,
    },
    reason: "test",
    startedServerTs: t0,
    startedClientTs: t0,
    clockOffsetMs: 0,
  });
  const pcm: Buffer[] = [];
  for (let seq = 0; seq < chunks; seq++) {
    const data = pcmChunk(samples, seq + seat * 10);
    pcm.push(data);
    await files.appendRecord(sessionId, fileName, key, seq, data);
    store.insertAudioChunk({
      trackId,
      seq,
      startSample: seq * samples,
      sampleCount: samples,
      clientTs: t0 + (seq * samples * 1000) / SAMPLE_RATE,
      clockOffsetMs: 0,
      serverTs: nowTs(),
      round: 0,
      phase: "lobby",
      rmsDb: -20,
      peakDb: -6,
      clipped: 0,
    });
  }
  return { trackId, fileName, key, pcm };
}
