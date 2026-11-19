/**
 * A synthetic four-seat audio session written through the real Store and AudioFileStore,
 * the way the live ingest path stores it: one encrypted `.wka` per track (one record per
 * 5 s chunk), the chunk index in `audio_chunks`, and the calibration in the event log.
 * The audio is the speech-like mix of ./attributionSynth.ts (no real voices).
 */
import {
  type EventType,
  generateParticipantCode,
  generateSessionId,
  type NewEvent,
  type PayloadOf,
} from "@wkwa/shared";
import type { AudioFileStore } from "../src/audio/fileStore";
import type { Store } from "../src/db/store";
import { type SynthConfig, type SynthSession, synthesise } from "./attributionSynth";
import { insertBareSession, writeTestTrack } from "./audioFixtures";

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
  insertBareSession(store, sessionId, synth.t0);
  const codes: Record<number, string> = {};
  for (const s of synth.seats) codes[s] = generateParticipantCode();
  const ev = <T extends EventType>(type: T, payload: PayloadOf<T>, ts: number, seat: number | null = null) =>
    store.appendEvent(
      sessionId,
      { type, actorKind: "system", seat, participantCode: null, payload } as NewEvent,
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
    const first = t.chunks[0]!;
    const last = t.chunks[t.chunks.length - 1]!;
    const { trackId } = await writeTestTrack(store, files, {
      sessionId,
      seat: t.seat,
      participantCode: codes[t.seat]!,
      reason: "mic_check",
      startedServerTs: first.serverTs - 5000,
      startedClientTs: first.clientTs,
      levels: { rmsDb: -30, peakDb: -10 },
      chunks: t.chunks.map((c) => {
        const pcm = t.pcm.subarray(c.startSample, c.startSample + c.sampleCount);
        return { ...c, pcm: Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength) };
      }),
      closedServerTs: last.serverTs + 10,
    });
    trackIds[t.seat] = [...(trackIds[t.seat] ?? []), trackId];
  }
  return { sessionId, synth, codes, trackIds };
}
