import { randomUUID } from "node:crypto";
import { AUDIO_SAMPLE_RATE } from "@wkwa/shared";
import type { AudioFileStore, AudioReadIssue } from "../src/audio/fileStore";
import type { Store } from "../src/db/store";
import { nowTs } from "../src/runtime";

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
      : Math.round(amp * Math.sin((2 * Math.PI * 440 * (i + seed * samples)) / AUDIO_SAMPLE_RATE));
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

/** One chunk for writeTestTrack: its index row and its samples. */
export interface TestChunk {
  seq: number;
  startSample: number;
  sampleCount: number;
  clientTs: number;
  serverTs: number;
  pcm: Buffer;
}

/**
 * Write a track the way the live path does: a new encrypted file, the track row, then per chunk
 * the record and its index row. With `closedServerTs` the track is closed (stop reason game_complete).
 */
export async function writeTestTrack(
  store: Store,
  files: AudioFileStore,
  t: {
    sessionId: string;
    seat: number;
    participantCode: string;
    reason: string;
    startedServerTs: number;
    startedClientTs: number;
    chunks: readonly TestChunk[];
    levels: { rmsDb: number; peakDb: number };
    closedServerTs?: number;
  },
): Promise<{ trackId: string; fileName: string; key: Buffer }> {
  const trackId = randomUUID();
  const { fileName, key } = await files.createFile(t.sessionId);
  store.insertAudioTrack({
    trackId,
    sessionId: t.sessionId,
    seat: t.seat,
    participantCode: t.participantCode,
    fileName,
    fileKey: key,
    sampleRate: AUDIO_SAMPLE_RATE,
    settings: {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      sampleRate: 48_000,
    },
    reason: t.reason,
    startedServerTs: t.startedServerTs,
    startedClientTs: t.startedClientTs,
    clockOffsetMs: 0,
  });
  for (const c of t.chunks) {
    await files.appendRecord(t.sessionId, fileName, key, c.seq, c.pcm);
    store.insertAudioChunk({
      trackId,
      seq: c.seq,
      startSample: c.startSample,
      sampleCount: c.sampleCount,
      clientTs: c.clientTs,
      clockOffsetMs: 0,
      serverTs: c.serverTs,
      round: 0,
      phase: "lobby",
      ...t.levels,
      clipped: 0,
    });
  }
  if (t.closedServerTs !== undefined)
    store.closeAudioTrack(trackId, { closedServerTs: t.closedServerTs, stopReason: "game_complete" });
  return { trackId, fileName, key };
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
  const t0 = nowTs();
  const pcm = Array.from({ length: chunks }, (_, seq) => pcmChunk(samples, seq + seat * 10));
  const t = await writeTestTrack(store, files, {
    sessionId,
    seat,
    participantCode,
    reason: "test",
    startedServerTs: t0,
    startedClientTs: t0,
    levels: { rmsDb: -20, peakDb: -6 },
    chunks: pcm.map((data, seq) => ({
      seq,
      startSample: seq * samples,
      sampleCount: samples,
      clientTs: t0 + (seq * samples * 1000) / AUDIO_SAMPLE_RATE,
      serverTs: nowTs(),
      pcm: data,
    })),
  });
  return { ...t, pcm };
}

/**
 * A track's PCM as stored: the first valid record of each seq, concatenated in seq order (gaps
 * are not filled), with the seqs read, the resent copies skipped and the read problems.
 */
export async function readTrackPcm(
  files: AudioFileStore,
  sessionId: string,
  fileName: string,
  key: Buffer,
): Promise<{ pcm: Buffer; seqs: number[]; duplicates: number; issues: AudioReadIssue[] }> {
  const issues: AudioReadIssue[] = [];
  const records = [];
  for await (const r of files.readUniqueRecords(sessionId, fileName, key, { onIssue: (i) => issues.push(i) }))
    records.push(r);
  records.sort((a, b) => a.seq - b.seq);
  const valid = (await files.verifyFile(sessionId, fileName, key)).records;
  return {
    pcm: Buffer.concat(records.map((r) => r.data)),
    seqs: records.map((r) => r.seq),
    duplicates: valid - records.length,
    issues,
  };
}
