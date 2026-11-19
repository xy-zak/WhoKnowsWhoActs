import { int16FromLeBytes } from "@wkwa/shared";
import { describe, expect, it } from "vitest";
import { MicRecorder, type MicRecorderOptions } from "../src/audio/MicRecorder";
import { resampledLength } from "../src/audio/resampler";
import type {
  AudioChunk,
  AudioStartInfo,
  AudioStopInfo,
  RecorderState,
  SendResult,
} from "../src/audio/types";

/**
 * A fake Web Audio + getUserMedia environment: the test drives the clock and
 * feeds the worklet's blocks; every created node and stream is counted.
 */
class FakeTrack extends EventTarget {
  stopped = false;
  muted = false;
  stop() {
    this.stopped = true;
  }
  getSettings() {
    return {
      deviceId: "secret-device",
      groupId: "secret-group",
      label: "Headset (secret)",
      sampleRate: 48000,
      channelCount: 1,
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      latency: 0.01,
    };
  }
}

class FakeStream {
  readonly track = new FakeTrack();
  getTracks() {
    return [this.track];
  }
  getAudioTracks() {
    return [this.track];
  }
}

class FakeNode {
  connected = 0;
  disconnected = 0;
  closeRequested = false;
  port = {
    onmessage: null as ((e: { data: unknown }) => void) | null,
    postMessage: (m: { type: string }) => {
      if (m.type === "close" && !this.closeRequested) {
        this.closeRequested = true;
        queueMicrotask(() => this.port.onmessage?.({ data: { type: "closed" } }));
      }
    },
  };
  connect() {
    this.connected++;
  }
  disconnect() {
    this.disconnected++;
  }
}

class FakeContext extends EventTarget {
  state: string = "suspended";
  sampleRate = 48000;
  baseLatency = 0.01;
  outputLatency = 0.02;
  /** rendered frames */
  frames = 0;
  destination = {};
  closed = false;
  get currentTime() {
    return this.frames / this.sampleRate;
  }
  getOutputTimestamp() {
    // origin: frame 0 rendered at perf 1000 ms
    return {
      contextTime: Math.max(0, this.currentTime - 0.03),
      performanceTime: this.state === "running" ? 1000 + this.currentTime * 1000 : 0,
    };
  }
  async resume() {
    this.setState("running");
  }
  async close() {
    this.closed = true;
    this.setState("closed");
  }
  setState(s: string) {
    if (this.state === s) return;
    this.state = s;
    this.dispatchEvent(new Event("statechange"));
  }
  createMediaStreamSource() {
    return env.sources.at(-1)!;
  }
}

let env: ReturnType<typeof makeEnv>;

function makeEnv() {
  const clock = { perf: 1000 };
  const e = {
    clock,
    contexts: [] as FakeContext[],
    nodes: [] as FakeNode[],
    sources: [] as FakeNode[],
    streams: [] as FakeStream[],
    modules: 0,
    permission: "granted" as PermissionState,
    gumError: null as Error | null,
    /** when set, getUserMedia waits for it (an open permission prompt) */
    prompt: null as Promise<void> | null,
    get ctx() {
      return this.contexts.at(-1)!;
    },
    get node() {
      return this.nodes.at(-1)!;
    },
    /** Renders `seconds` of a 440 Hz tone in 1920-frame blocks and delivers them to the worklet node. */
    render(seconds: number, amp = 0.3) {
      const ctx = this.ctx;
      const total = Math.round(seconds * ctx.sampleRate);
      for (let done = 0; done < total; done += 1920) {
        const n = Math.min(1920, total - done);
        const samples = new Float32Array(n);
        for (let i = 0; i < n; i++)
          samples[i] = amp * Math.sin((2 * Math.PI * 440 * (ctx.frames + i)) / 48000);
        const frame = ctx.frames;
        ctx.frames += n;
        clock.perf = 1000 + (ctx.frames / ctx.sampleRate) * 1000 + 2;
        this.node.port.onmessage?.({ data: { type: "pcm", frame, samples } });
      }
    },
  };
  return e;
}

function recorder(over: Partial<MicRecorderOptions> = {}) {
  env = makeEnv();
  const sent: Array<
    | { kind: "start"; m: AudioStartInfo }
    | { kind: "chunk"; m: AudioChunk }
    | { kind: "stop"; m: AudioStopInfo }
  > = [];
  const states: RecorderState[] = [];
  let online = true;
  let uuid = 0;
  const ack = (): Promise<SendResult> => Promise.resolve(online);
  const rec = new MicRecorder({
    now: () => env.clock.perf + 1.7e12,
    clockOffsetMs: () => 12.5,
    sendStart: (m) => {
      if (online) sent.push({ kind: "start", m });
      return ack();
    },
    sendChunk: (m) => {
      if (online) sent.push({ kind: "chunk", m });
      return ack();
    },
    sendStop: (m) => {
      if (online) sent.push({ kind: "stop", m });
      return ack();
    },
    onState: (s) => states.push(s),
    retryDelaysMs: [60_000],
    env: {
      createContext: () => {
        const c = new FakeContext();
        env.contexts.push(c);
        return c as unknown as AudioContext;
      },
      getUserMedia: async () => {
        if (env.prompt) await env.prompt;
        if (env.gumError) throw env.gumError;
        const s = new FakeStream();
        env.streams.push(s);
        env.sources.push(new FakeNode());
        return s as unknown as MediaStream;
      },
      createNode: () => {
        const n = new FakeNode();
        env.nodes.push(n);
        return n as unknown as AudioWorkletNode;
      },
      loadWorklet: async () => {
        env.modules++;
      },
      perfNow: () => env.clock.perf,
      randomUUID: () => `track-${++uuid}`,
      support: () => null,
      permission: async () => env.permission,
    },
    ...over,
  });
  return {
    rec,
    sent,
    states,
    setOnline(v: boolean) {
      online = v;
    },
  };
}

const chunksOf = (sent: ReturnType<typeof recorder>["sent"], trackId?: string) =>
  sent
    .filter((s) => s.kind === "chunk" && (!trackId || s.m.trackId === trackId))
    .map((s) => s.m as AudioChunk);

describe("MicRecorder", () => {
  it("records 11 s as two full chunks and a partial one, with contiguous samples and timing", async () => {
    const { rec, sent, states } = recorder();
    expect(await rec.start("mic_check")).toBe("recording");
    env.render(11);
    await rec.stop("done");
    await rec.whenSent();
    // onState also fires when only the track changes; the states themselves:
    expect(states.filter((x, i) => x !== states[i - 1])).toEqual(["idle", "requesting", "recording", "idle"]);

    expect(sent.map((s) => s.kind)).toEqual(["start", "chunk", "chunk", "chunk", "stop"]);
    const start = sent[0]!.m as AudioStartInfo;
    expect(start).toMatchObject({
      trackId: "track-1",
      reason: "mic_check",
      sampleRate: 16000,
      chunkSamples: 80000,
      clockOffsetMs: 12.5,
      inputLatencyMs: 10,
      context: { sampleRate: 48000, baseLatencyMs: 10, outputLatencyMs: 20 },
    });
    expect(start.settings).toEqual({
      sampleRate: 48000,
      channelCount: 1,
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      latency: 0.01,
    });
    expect(JSON.stringify(start)).not.toMatch(/secret|deviceId|groupId|label/);

    const chunks = chunksOf(sent);
    expect(chunks.map((c) => c.sampleCount)).toEqual([80000, 80000, resampledLength(528000, 48000) - 160000]);
    expect(chunks.map((c) => c.startSample)).toEqual([0, 80000, 160000]);
    expect(chunks.map((c) => c.seq)).toEqual([0, 1, 2]);
    for (const c of chunks) {
      expect(c.pcm.byteLength).toBe(c.sampleCount * 2);
      expect(c.rmsDb).toBeCloseTo(-13.5, 0); // 0.3 amplitude sine
      expect(c.clippedSamples).toBe(0);
    }
    // frame 0 rendered at perf 1000; 10 ms input latency; epoch = perf + 1.7e12
    expect(chunks[0]!.clientTs).toBeCloseTo(1.7e12 + 1000 - 10, 3);
    expect(chunks[1]!.clientTs - chunks[0]!.clientTs).toBeCloseTo(5000, 3);
    expect(chunks[2]!.clientTs - chunks[1]!.clientTs).toBeCloseTo(5000, 3);
    const stop = sent.at(-1)!.m as AudioStopInfo;
    expect(stop).toMatchObject({ trackId: "track-1", reason: "done", chunks: 3, samples: 176000 });
    expect(stop.clientTs - chunks[0]!.clientTs).toBeCloseTo(11000, 3);
    const pcm = int16FromLeBytes(chunks[0]!.pcm);
    expect(Math.max(...pcm.subarray(0, 1000))).toBeGreaterThan(9000);
  });

  it("survives many start/stop cycles without leaking nodes or streams", async () => {
    const { rec, sent } = recorder();
    for (let i = 0; i < 40; i++) {
      await rec.start(`cycle-${i}`);
      env.render(0.3);
      await rec.stop();
    }
    await rec.whenSent();
    expect(env.contexts).toHaveLength(1);
    expect(env.streams).toHaveLength(40);
    expect(env.streams.every((s) => s.track.stopped)).toBe(true);
    expect(env.nodes.every((n) => n.disconnected > 0 && n.closeRequested && n.port.onmessage === null)).toBe(
      true,
    );
    expect(env.sources.every((n) => n.disconnected > 0)).toBe(true);
    const ids = sent.filter((s) => s.kind === "start").map((s) => s.m.trackId);
    expect(new Set(ids).size).toBe(40);
    expect(sent.filter((s) => s.kind === "stop")).toHaveLength(40);
    await rec.dispose();
    expect(env.ctx.closed).toBe(true);
    await expect(rec.start()).rejects.toThrow(/disposed/);
  });

  it("keeps unacked chunks in memory and resends them in order after a reconnect", async () => {
    const { rec, sent, setOnline } = recorder({ chunkSeconds: 1 });
    await rec.start();
    setOnline(false);
    env.render(10.1); // a little past 10 s: the resampler's 2.5 ms lookahead completes chunk 9
    await Promise.resolve();
    expect(rec.pendingChunks).toBe(10);
    expect(rec.pendingBytes).toBe(10 * 32000);
    setOnline(true);
    rec.onReconnect();
    await rec.whenSent();
    expect(sent.map((s) => s.kind)).toEqual(["start", ...Array(10).fill("chunk")]);
    expect(chunksOf(sent).map((c) => c.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(rec.pendingChunks).toBe(0);
    await rec.stop();
  });

  it("drops the oldest chunks beyond maxPendingSeconds and counts them", async () => {
    const { rec, sent, setOnline } = recorder({ chunkSeconds: 1, maxPendingSeconds: 3 });
    await rec.start();
    setOnline(false);
    env.render(6.1);
    expect(rec.droppedChunks).toBe(3);
    expect(rec.pendingChunks).toBe(3);
    setOnline(true);
    rec.onReconnect();
    await rec.whenSent();
    expect(chunksOf(sent).map((c) => c.seq)).toEqual([3, 4, 5]);
    await rec.stop();
  });

  it("reports a denied permission with help text", async () => {
    const { rec } = recorder();
    env.gumError = Object.assign(new Error("Permission denied"), { name: "NotAllowedError" });
    expect(await rec.start()).toBe("denied");
    expect(rec.status.error).toMatchObject({ kind: "denied", name: "NotAllowedError" });
    expect(rec.status.error!.steps.length).toBeGreaterThan(0);
    env.gumError = null;
    expect(await rec.start()).toBe("recording");
    await rec.stop();
  });

  it("ends the track when the microphone ends, and says denied when the permission was revoked", async () => {
    const { rec, sent } = recorder();
    await rec.start();
    env.render(1);
    env.permission = "denied";
    env.streams[0]!.track.dispatchEvent(new Event("ended"));
    await new Promise((r) => setTimeout(r, 0));
    expect(rec.state).toBe("denied");
    expect(env.streams[0]!.track.stopped).toBe(true);
    await rec.whenSent();
    expect(sent.at(-1)).toMatchObject({ kind: "stop", m: { reason: "track_ended", samples: 16000 } });
  });

  it("splits the track at a context suspension and continues in a new track after the resume", async () => {
    const { rec, sent } = recorder();
    await rec.start();
    env.render(2);
    env.ctx.setState("suspended");
    expect(rec.state).toBe("paused");
    expect(rec.status.needsGesture).toBe(true);
    await new Promise((r) => setTimeout(r, 350)); // grace period: the partial chunk is sent
    await rec.whenSent();
    expect(sent.at(-1)).toMatchObject({ kind: "stop", m: { reason: "context_suspended", samples: 32000 } });
    expect(await rec.resume()).toBe(true);
    env.clock.perf += 5000; // real time went on while suspended
    env.render(1);
    await rec.stop();
    await rec.whenSent();
    const starts = sent.filter((s) => s.kind === "start").map((s) => s.m as AudioStartInfo);
    expect(starts.map((s) => s.reason)).toEqual(["start", "context_resumed"]);
    const second = chunksOf(sent, starts[1]!.trackId);
    expect(second[0]!.startSample).toBe(0);
    expect(rec.lateFrames).toBe(0);
  });

  it("starts a new track when the audio clock jumps", async () => {
    const { rec, sent } = recorder();
    await rec.start();
    env.render(1);
    const ctx = env.ctx;
    // the clock stalled: context time stood still while 3 s passed
    const frame = ctx.frames;
    ctx.frames += 1920;
    env.clock.perf += 3000;
    env.node.port.onmessage?.({ data: { type: "pcm", frame, samples: new Float32Array(1920) } });
    await rec.stop();
    await rec.whenSent();
    expect(sent.filter((s) => s.kind === "stop").map((s) => s.m.reason)).toEqual(["clock_jump", "stop"]);
    expect(sent.filter((s) => s.kind === "start").map((s) => s.m.reason)).toEqual(["start", "clock_jump"]);
  });

  it("reports no signal for digital silence and for a muted track", async () => {
    const { rec } = recorder();
    await rec.start();
    env.render(4, 0);
    expect(rec.state).toBe("no_signal");
    env.render(0.5);
    expect(rec.state).toBe("recording");
    env.streams[0]!.track.dispatchEvent(new Event("mute"));
    expect(rec.state).toBe("no_signal");
    expect(rec.status.muted).toBe(true);
    env.streams[0]!.track.dispatchEvent(new Event("unmute"));
    expect(rec.state).toBe("recording");
    await rec.stop();
  });

  it("feeds 16 kHz samples to taps and levels about 4 times per second", async () => {
    const levels: number[] = [];
    const { rec } = recorder({ onLevel: (l) => levels.push(l.rmsDb) });
    let tapped = 0;
    const off = rec.addTap((s) => {
      tapped += s.length;
    });
    await rec.start();
    env.render(2);
    off();
    env.render(1);
    await rec.stop();
    expect(tapped).toBeGreaterThan(31000);
    expect(tapped).toBeLessThanOrEqual(32000);
    expect(levels.length).toBe(12);
    expect(levels[2]).toBeCloseTo(-13.5, 0);
  });

  it("cancels a start that is still waiting for the permission prompt", async () => {
    const { rec, sent } = recorder();
    let answer = () => {};
    env.prompt = new Promise<void>((r) => {
      answer = r;
    });
    const started = rec.start();
    await Promise.resolve();
    expect(rec.state).toBe("requesting");
    await rec.stop();
    answer(); // the participant clicks Allow after the stop
    expect(await started).toBe("idle");
    expect(env.streams).toHaveLength(1);
    expect(env.streams[0]!.track.stopped).toBe(true);
    expect(env.nodes).toHaveLength(0);
    expect(sent).toHaveLength(0);
    // a later start works normally
    env.prompt = null;
    expect(await rec.start()).toBe("recording");
    await rec.stop();
  });

  it("honours the last call in stop → start → stop", async () => {
    const { rec } = recorder();
    await rec.start();
    env.render(1);
    const first = rec.stop("a");
    const restarted = rec.start("again");
    const second = rec.stop("b");
    await Promise.all([first, second]);
    expect(await restarted).toBe("idle");
    expect(rec.state).toBe("idle");
    expect(env.streams).toHaveLength(1);
    expect(env.streams.every((s) => s.track.stopped)).toBe(true);
  });

  it("clearPending() drops unsent audio and starts a fresh track, so no chunk lacks its start", async () => {
    const { rec, sent, setOnline } = recorder({ chunkSeconds: 1 });
    await rec.start();
    setOnline(false);
    env.render(2.1);
    expect(rec.pendingChunks).toBe(2);
    expect(rec.clearPending()).toBe(3); // 2 chunks + the flushed partial one
    expect(rec.pendingChunks).toBe(0);
    setOnline(true);
    env.render(1.1);
    await rec.stop();
    await rec.whenSent();
    const starts = sent.filter((s) => s.kind === "start").map((s) => s.m as AudioStartInfo);
    expect(starts.map((s) => s.reason)).toEqual(["cleared"]);
    for (const c of chunksOf(sent)) expect(c.trackId).toBe(starts[0]!.trackId);
    expect(chunksOf(sent)[0]!.seq).toBe(0);
  });

  it("start() from a click while paused resumes the AudioContext", async () => {
    const { rec } = recorder();
    await rec.start();
    env.render(0.5);
    env.ctx.state = "suspended"; // no event: as if the resume needs a gesture
    env.ctx.dispatchEvent(new Event("statechange"));
    expect(rec.state).toBe("paused");
    void rec.start();
    await Promise.resolve();
    expect(env.ctx.state).toBe("running");
    await rec.stop();
  });

  it("fills a short gap in the worklet's frames with silence, and splits the track at a long one", async () => {
    const { rec, sent } = recorder();
    await rec.start();
    env.render(0.5);
    env.ctx.frames += 512; // the processor was skipped for 4 quanta
    env.render(0.5);
    expect(rec.gapFrames).toBe(512);
    // a quantum delivered twice (seen in Chromium right after a node starts): the repeat is dropped
    const dupFrame = env.ctx.frames - 128;
    env.node.port.onmessage?.({ data: { type: "pcm", frame: dupFrame, samples: new Float32Array(256) } });
    env.ctx.frames += 128;
    expect(rec.overlapFrames).toBe(128);
    env.ctx.frames += 48000 * 2; // 2 s missing: not silence we may invent
    env.render(0.5);
    await rec.stop();
    await rec.whenSent();
    expect(sent.filter((s) => s.kind === "stop").map((s) => [s.m.reason, s.m.samples])).toEqual([
      ["discontinuity", resampledLength(48000 + 512 + 128, 48000)],
      ["stop", 8000],
    ]);
  });
});
