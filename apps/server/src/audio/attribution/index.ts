/**
 * # Speaker attribution engine ("who spoke when")
 *
 * All four players sit in one room, so every mic also records the other three voices. This
 * engine decides, per 10 ms, which seat is speaking, using **only the loudness of each mic
 * relative to the others** ("cross-channel energy comparison"). It runs offline after a
 * session (triggered from the DATABASE tab, in a `worker_thread`), never modifies the raw audio,
 * and produces:
 *
 * - a speech timeline: segments `{seat, startTs, endTs, durationMs, meanDb, confidence, overlap}` on
 *   the server clock, per-seat talk time and total overlap;
 * - per-seat frame masks (run-length encoded) and streaming renderers for **aligned** tracks (all
 *   seats on one timeline, drift-corrected) and **clean** tracks (frames not attributed to the seat
 *   attenuated by 30 dB, with 10 ms fades), for listening and for transcription;
 * - an alignment per track and a quality report (calibration margins per seat, ambiguous, clipped
 *   and missing shares, drift, lag statistics, warnings in plain English).
 *
 * ## GDPR: attribution, not identification
 *
 * The engine compares levels between mics. It never computes speaker embeddings, voiceprints,
 * pitch or spectral profiles, and it never tries to recognise *who* a voice belongs to. It only
 * answers "which seat's mic is this sound closest to?". The seat-to-person link exists only through
 * the session's seat binding, exactly as for clicks. Using voice to identify people would be
 * Art. 9 GDPR biometric processing; this design avoids it on purpose.
 *
 * ## Pipeline
 *
 * 1. **Envelopes** (`envelope.ts`, streaming). Each track's PCM is reduced, chunk by chunk, to a
 *    10 ms-hop log-energy envelope over 20 ms windows (after a 100 Hz high-pass), with peak and
 *    clip flags. Analysis works on envelopes only: an hour per seat is 360 000 frames (≈ 3 MB),
 *    not ≈ 115 MB of PCM, and the four channels' PCM is never needed in memory at once.
 * 2. **Clock fit** (`clock.ts`). A robust regression of `clientTs` on `startSample` gives each
 *    track's start time and effective sample rate (drift in ppm); all tracks of a seat share one
 *    drift, since it is a property of the device.
 * 3. **Timeline** (`timeline.ts`). Every track is resampled onto one grid of 10 ms frames from `t0`.
 *    Gaps (no track, lost chunks) are "no data", which is never confused with silence.
 * 4. **Noise floor** (`noiseFloor.ts`). The 5th percentile of each channel over a sliding 30 s
 *    window.
 * 5. **Lag refinement** (`lag.ts`): the "audio file comparison". Crosstalk puts the same speech
 *    rhythm on every mic, so cross-correlating the channels' envelopes (40 s windows, ±500 ms)
 *    measures the remaining misalignment. A least-squares solve gives per-track offsets and
 *    per-device drift corrections, anchored to the track with the most data. Then step 3 runs again
 *    with the refined alignment.
 * 6. **Leakage matrix** (`leakage.ts`). `G[s][j]` = how much quieter seat s's voice is on mic j
 *    than on its own mic. It is measured from the facilitator-led **calibration** (each seat reads a
 *    sentence for about 6 s while the others stay quiet). Without calibration it is estimated from
 *    stretches where one mic clearly dominates, then refined once from the first attribution. The
 *    calibration also yields a per-seat quality verdict. `quickCalibrationCheck` runs just that on
 *    the calibration window, live, in milliseconds.
 * 7. **Frame attribution** (`frames.ts`). Per frame, the dominant speaker is the seat whose
 *    leakage pattern `E_s + G[s][·]` (plus noise floors) best explains the four levels. Another
 *    seat is an **overlapping** speaker only if its mic exceeds the leakage predicted from the
 *    dominant speaker by a calibrated margin. A seat whose mic has no data can still win the
 *    frame, which then stays unattributed instead of being credited to a neighbour.
 * 8. **Smoothing** (`smooth.ts`). Per seat: bridge pauses < 200 ms, drop speech < 250 ms, add a
 *    100 ms hangover and a 20 ms pre-roll (never into another seat's dominant frames or into gaps).
 * 9. **Outputs and rendering** (`analyse.ts`, `render.ts`, `annotate.ts`, `../wav.ts`).
 *
 * ## Hardware: headsets to laptops
 *
 * Participants bring their own laptops. With headsets, the other voices arrive 15–25 dB lower
 * (decision margin about 20 dB); with built-in laptop mics only 3–10 dB lower. Mic gains and noise
 * floors differ widely. The engine copes in three ways:
 * - it compares patterns, not raw levels, so gain differences cancel (see `leakage.ts`);
 * - it lowers per-frame confidence where the patterns are close;
 * - it **reports** the decision margin per seat. Margins below `minMarginDb` (10 dB) raise a
 *   warning with advice ("move the mic closer or use a headset").
 *
 * Overlap detection needs margin: with laptop mics, a quieter second voice cannot be separated
 * from leakage, so overlap is under-reported there.
 *
 * ## Measured on synthetic mixes (tests in `apps/server/test/attribution*.test.ts`)
 *
 * The test mixes are speech-like band-limited noise with syllabic modulation, word, pause and
 * turn structure, about 10 % overlapping speech, per-path spectral tilt and level wobble, known
 * leakage, per-device delay, ±100 ppm drift, ±20 ms timestamp jitter, noise floors and gain
 * differences. Results (100 ms collar):
 * - headset-like: ≥ 97 % single-speaker frame accuracy, ≥ 80 % overlap recall, < 2 % false talk;
 * - laptop-like: ≥ 90 % accuracy, with low-margin warnings raised;
 * - drift within ±5 ppm, relative offsets within ±10 ms, calibrated leakage within ±1.5 dB.
 *
 * Analysing 10 minutes of 4-channel audio (envelopes plus analysis) takes well under 10 s on a
 * laptop CPU (≈ 0.3 s per 5 minutes, measured); see the performance test.
 *
 * ## Known limits
 *
 * - **Absolute drift** comes from the client timestamps. With ±20 ms jitter it is only good to
 *   about ±25 ppm on a 5-minute session, but ±1 ppm on an hour-long one. The *relative*
 *   alignment between mics, which is what attribution needs, is within a few ms either way.
 * - **Absolute time** is referenced to the anchor device's client timestamps. That device's
 *   constant input latency (typically 10–40 ms) cannot be recovered from audio.
 * - **Laptop mics without calibration**: the estimated leakage can lock onto a wrong pattern when
 *   gains and noise floors differ a lot. One synthetic seed dropped to ≈ 75 % accuracy. The quality
 *   report then shows "poor" and a high ambiguous share. Run the calibration with laptops.
 * - **A seat whose mic dropped out** while its participant speaks: with headsets the frames stay
 *   unattributed, as intended. With laptop leakage (−4 dB) that voice can look like a neighbour
 *   speaking and be credited to them.
 * - Energy alone cannot tell a voice from other sounds made close to one mic (typing on a laptop,
 *   a cough). The 250 ms minimum and the per-segment confidence limit, but do not remove, such
 *   false speech.
 *
 * ## Use (wave 2)
 *
 * ```ts
 * const b = new EnvelopeBuilder();
 * for await (const c of decryptedChunks(track)) b.push(c.samples, c.startSample);
 * const result = analyse({ tracks: [{ trackId, seat, chunks: chunkMetas, envelope: b.finish() }, …],
 *                          seats: [1, 2, 3, 4], calibration: { turns } });
 * const mask = result.masks.find((m) => m.seat === 1)!;
 * const total = renderedSampleCount(result.timeline);
 * for await (const bytes of wavStream(renderClean(1, sources, result, mask), { sampleRate: 16000 }, total)) …
 * ```
 */

export { analyse } from "./analyse";
export { type AnnotatedSegment, annotate, type PhaseChange } from "./annotate";
export {
  type ClockFit,
  driftFromMsPerSample,
  fitClocks,
  msPerSampleFromDrift,
  trackSampleEnd,
} from "./clock";
export { buildEnvelope, EnvelopeBuilder, type EnvelopeOptions } from "./envelope";
export { type CalibrationChannel, calibrationChannelsFromTracks, quickCalibrationCheck } from "./leakage";
export {
  type CleanOptions,
  type PcmChunk,
  type RenderOptions,
  type RenderTiming,
  renderAligned,
  renderClean,
  renderedSampleCount,
  SequentialPcmReader,
  type TrackSource,
} from "./render";
export { maskToRuns, runsToMask } from "./smooth";
export * from "./types";
