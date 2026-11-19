import { describe, expect, it } from "vitest";
import type { z } from "zod";
import {
  AudioCaptureSettingsSchema,
  AudioContextInfoSchema,
  AudioSettingsSchema,
  AudioStart,
  EngineCaptureSettingsSchema,
  EVENT_DEFS,
  MicCheckSubmit,
} from "../src/index";

// Pins what the audio settings schemas accept, reject and strip (the privacy whitelist).
const parse = (schema: z.ZodType, input: unknown) => {
  const r = schema.safeParse(input);
  return r.success
    ? { ok: r.data }
    : { issues: r.error.issues.map(({ code, path, message }) => ({ code, path, message })) };
};

const SETTINGS = {
  sampleRate: 48000,
  echoCancellation: false,
  noiseSuppression: true,
  autoGainControl: false,
  channelCount: 1,
};
const SETTINGS_INPUTS = [
  SETTINGS,
  { ...SETTINGS, deviceId: "abc", groupId: "def", label: "USB headset" },
  { ...SETTINGS, sampleSize: 16, latency: 0.01, voiceIsolation: true },
  {},
  { echoCancellation: "remote-only" },
  { ...SETTINGS, echoCancellation: "none" },
  { ...SETTINGS, echoCancellation: "x".repeat(41) },
  { ...SETTINGS, sampleRate: 8000 },
  { ...SETTINGS, sampleRate: 384000 },
  { ...SETTINGS, sampleRate: 7999 },
  { ...SETTINGS, sampleRate: 384001 },
  { ...SETTINGS, sampleRate: 44100.5 },
  { ...SETTINGS, sampleRate: "48000" },
  { ...SETTINGS, channelCount: 0 },
  { ...SETTINGS, channelCount: 33 },
  { ...SETTINGS, noiseSuppression: "yes" },
  null,
];
const CONTEXT = {
  sampleRate: 44100,
  baseLatencyMs: 5.8,
  outputLatencyMs: null,
  timingMethod: "current-time",
};
const CONTEXT_INPUTS = [
  CONTEXT,
  { ...CONTEXT, deviceId: "abc" },
  { ...CONTEXT, sampleRate: 7999 },
  { ...CONTEXT, sampleRate: 384001 },
  { ...CONTEXT, sampleRate: 22050.5 },
  { ...CONTEXT, timingMethod: "x".repeat(41) },
  { ...CONTEXT, baseLatencyMs: undefined },
];
const START = {
  trackId: "1b4e28ba-2fa1-4d2b-883f-0016d3cca427",
  reason: "mic_check",
  sampleRate: 16000,
  chunkSamples: 80000,
  clientTs: 1_794_826_000_000,
  clockOffsetMs: -3,
  inputLatencyMs: 12,
  settings: SETTINGS,
  context: CONTEXT,
};
const START_INPUTS = [
  START,
  { ...START, extra: 1, settings: { ...SETTINGS, deviceId: "abc", label: "USB" } },
  { ...START, settings: { echoCancellation: "all" } },
  { ...START, settings: { echoCancellation: "all" }, context: undefined },
  { ...START, chunkSamples: undefined, inputLatencyMs: undefined, context: undefined },
  { ...START, sampleRate: 48000 },
  { ...START, reason: "nope" },
  { ...START, trackId: "seat-1" },
  { ...START, chunkSamples: 0 },
  { ...START, inputLatencyMs: 10_001 },
  { ...START, context: { ...CONTEXT, sampleRate: 1 } },
  {},
];
const MIC = {
  passed: true,
  attempts: 1,
  durationMs: 9000,
  settings: SETTINGS,
  noiseFloorDb: -60,
  speechDb: -22,
  speechMs: 2500,
  clientTs: 1,
};
const MIC_INPUTS = [
  MIC,
  { ...MIC, extra: 1, settings: { ...SETTINGS, deviceId: "abc", label: "USB" } },
  { ...MIC, settings: { echoCancellation: "none" }, contextSampleRate: 44100 },
  { ...MIC, settings: { echoCancellation: "none" } },
  { ...MIC, settings: {}, contextSampleRate: 7999 },
  { ...MIC, settings: {}, contextSampleRate: 384001 },
  { ...MIC, settings: {}, contextSampleRate: 44100.5 },
  { ...MIC, contextSampleRate: 22050 },
];
const STARTED = { trackId: START.trackId, sampleRate: 16000, settings: SETTINGS, reason: "resume" };
const STARTED_INPUTS = [
  STARTED,
  { ...STARTED, extra: 1, settings: { ...SETTINGS, deviceId: "abc" } },
  { ...STARTED, settings: { echoCancellation: true } },
  { ...STARTED, sampleRate: 48000 },
];

describe("audio settings schemas (parse snapshot)", () => {
  it.each([
    ["AudioSettingsSchema", AudioSettingsSchema, SETTINGS_INPUTS],
    ["AudioCaptureSettingsSchema", AudioCaptureSettingsSchema, SETTINGS_INPUTS],
    ["EngineCaptureSettingsSchema", EngineCaptureSettingsSchema, SETTINGS_INPUTS],
    ["AudioContextInfoSchema", AudioContextInfoSchema, CONTEXT_INPUTS],
    ["AudioStart", AudioStart, START_INPUTS],
    ["MicCheckSubmit", MicCheckSubmit, MIC_INPUTS],
    ["AudioTrackStarted payload", EVENT_DEFS.AudioTrackStarted.payload, STARTED_INPUTS],
  ] as const)("%s", (_name, schema, inputs) => {
    expect(inputs.map((i) => parse(schema, i))).toMatchSnapshot();
  });
});
