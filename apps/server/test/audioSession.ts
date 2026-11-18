/**
 * A synthetic four-seat audio session written through the real Store and AudioFileStore,
 * the way the live ingest path stores it: one encrypted `.wka` per track (one record per
 * 5 s chunk), the chunk index in `audio_chunks`, and the calibration in the event log.
 * The audio is the speech-like mix of ./attributionSynth.ts (no real voices).
 */
import { randomUUID } from "node:crypto";
import { generateParticipantCode, generateSessionId } from "@wkwa/shared";
import type { AudioFileStore } from "../src/audio/fileStore";
import type { Store } from "../src/db/store";
import { wall } from "../src/runtime";
import { type SynthConfig, type SynthSession, synthesise } from "./attributionSynth";

export interface SeededSession {
  sessionId: string;
  synth: SynthSession;
  /** Participant code per seat. */
  codes: Record<number, string>;
  /** Track id per seat (first track). */
  trackIds: Record<number, string[]>;
}

export async function seedAudioSession(
  store: Store,
  files: AudioFileStore,
  cfg: Partial<SynthConfig> = {},
  opts: { sessionId?: string; calibration?: boolean } = {},
): Promise<SeededSession> {
  const synth = synthesise({ seed: 7, durationSec: 70, profile: "headset", calibration: true, ...cfg });
  const sessionId = opts.sessionId ?? generateSessionId(new Date(synth.t0));
  store.insertSession({
    id: sessionId,
    created_wall: wall(synth.t0),
    scenario_id: "demo",
    scenario_version: "1",
    scenario_hash: "h",
    status: "closed",
    tags_json: "[]",
    notes: "synthetic audio session",
    config_json: "{}",
    harness_version: "0",
    git_commit: "test",
  });
  const codes: Record<number, string> = {};
  for (const s of synth.seats) codes[s] = generateParticipantCode();
  const ev = (type: string, payload: unknown, ts: number, seat: number | null = null) =>
    store.appendEvent(
      sessionId,
      { type, actorKind: "system", seat, participantCode: null, payload } as Parameters<
        Store["appendEvent"]
      >[1],
      0,
      ts,
    );
  if (opts.calibration !== false && synth.turns.length) {
    const turns = synth.turns;
    ev(
      "CalibrationStarted",
      {
        order: turns.map((t) => t.seat),
        sentenceIds: turns.map((_, i) => `t-${i}`),
        turnMs: 6000,
        gapMs: 1000,
      },
      turns[0]!.startTs - 1,
    );
    turns.forEach((t, i) => {
      ev("CalibrationTurn", { index: i, seat: t.seat, sentenceId: `t-${i}` }, t.startTs);
    });
    ev(
      "CalibrationCompleted",
      {
        turns: turns.map((t, i) => ({
          seat: t.seat,
          sentenceId: `t-${i}`,
          startTs: t.startTs,
          endTs: t.endTs,
        })),
      },
      turns[turns.length - 1]!.endTs,
    );
  }
  // a game pause in the second half: segments that start inside it are flagged `paused`
  const mid = synth.t0 + synth.durationSec * 600;
  ev("GamePaused", { reason: "facilitator", seat: null }, mid);
  ev("GameResumed", { pausedMs: 5000 }, mid + 5000);

  const trackIds: Record<number, string[]> = {};
  for (const t of synth.tracks) {
    const trackId = randomUUID();
    trackIds[t.seat] = [...(trackIds[t.seat] ?? []), trackId];
    const { fileName, key } = await files.createFile(sessionId);
    const first = t.chunks[0]!;
    store.insertAudioTrack({
      trackId,
      sessionId,
      seat: t.seat,
      participantCode: codes[t.seat]!,
      fileName,
      fileKey: key,
      sampleRate: 16_000,
      settings: {
        sampleRate: 48_000,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
      reason: "mic_check",
      startedServerTs: first.serverTs - 5000,
      startedClientTs: first.clientTs,
      clockOffsetMs: 0,
    });
    for (const c of t.chunks) {
      const pcm = t.pcm.subarray(c.startSample, c.startSample + c.sampleCount);
      await files.appendRecord(
        sessionId,
        fileName,
        key,
        c.seq,
        Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength),
      );
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
        rmsDb: -30,
        peakDb: -10,
        clipped: 0,
      });
    }
    const last = t.chunks[t.chunks.length - 1]!;
    store.closeAudioTrack(trackId, { closedServerTs: last.serverTs + 10, stopReason: "game_complete" });
  }
  return { sessionId, synth, codes, trackIds };
}
