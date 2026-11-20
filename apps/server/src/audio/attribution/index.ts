/**
 * # Speaker attribution engine ("who spoke when")
 *
 * Every player wears a headset, so each mic hears its own player 20–30 dB louder than anyone
 * else at the table. That makes attribution a **gate**: seat s speaks in a 10 ms frame when
 *
 * 1. its mic hears speech (Silero VAD, a small speech/non-speech model; energy above the noise
 *    floor when the model is unavailable), and
 * 2. its level beats what every other seat's voice would leak onto it by a margin:
 *    `E_s ≥ E_j + L[j][s] + 6 dB` for every other mic j. `L` (leakage) is measured in the
 *    calibration (each seat reads a sentence while the others listen); without one, −10 dB.
 *
 * Another player's voice leaking onto a mic fails the gate; two people talking at once both pass,
 * so overlap is kept. The engine runs offline after a session, in a `worker_thread`, and never
 * modifies the raw audio.
 *
 * ## GDPR: attribution, not identification
 *
 * The engine compares levels between mics and asks a model "is this speech?". It never computes
 * speaker embeddings, voiceprints, pitch or spectral profiles, and never recognises *who* a voice
 * belongs to: the seat-to-person link exists only through the session's seat binding. Identifying
 * people by voice would be Art. 9 GDPR biometric processing; this design avoids it on purpose.
 *
 * ## Pipeline
 *
 * 1. **Features** (`features.ts`, streaming): per track, 10 ms frames of energy (after a 100 Hz
 *    high-pass), clip flags and the speech probability (`vad.ts`, 32 ms windows).
 * 2. **Clock fit** (`clock.ts`): a robust line of `clientTs` against `startSample` per track gives
 *    its start on the server clock and its drift.
 * 3. **Timeline** (`analyse.ts`): every seat's frames on one 10 ms grid; gaps are "no data".
 * 4. **Leakage** from the calibration, with a verdict per seat (`measureCalibration`);
 *    `quickCalibrationCheck` runs just that, live, on the calibration window.
 * 5. **Gate** per frame and seat (above), then **smoothing** (`smooth.ts`): bridge pauses < 200 ms,
 *    drop speech < 250 ms, 100 ms hangover, 20 ms pre-roll.
 * 6. **Outputs**: segments, talk time, overlap, masks, a quality report; `render.ts` streams
 *    aligned and clean tracks (other seats' frames attenuated by 30 dB); `annotate.ts` adds round
 *    and phase to each segment.
 *
 * ## Known limits
 *
 * - Absolute time comes from the client timestamps (± a few tens of ms, plus the device's input
 *   latency); that is below the smoothing and does not affect who spoke.
 * - Without headsets (laptop mics, 3–10 dB separation) the gate misses quiet overlapping speech and
 *   the calibration flags a low margin: run the calibration and use headsets.
 * - While a seat's mic has no data (dropout), its voice can only be gated against the mics that
 *   do, so a neighbour's detector may pick up its leak; the coverage warning flags such stretches.
 */

export { analyse, quickCalibrationCheck } from "./analyse";
export { type AnnotatedSegment, annotate, type PhaseChange } from "./annotate";
export { alignTrack, fitClock, trackSampleEnd } from "./clock";
export { FeatureBuilder, type Vad } from "./features";
export {
  type PcmChunk,
  type RenderTiming,
  renderAligned,
  renderClean,
  renderedSampleCount,
  type TrackSource,
} from "./render";
export { maskToRuns, runsToMask } from "./smooth";
export * from "./types";
export { loadSilero } from "./vad";
