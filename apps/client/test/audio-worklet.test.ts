import { describe, expect, it } from "vitest";
import { batchFramesFor, CAPTURE_PROCESSOR, CAPTURE_WORKLET_SOURCE } from "../src/audio/worklet";

interface Posted {
  type: string;
  frame?: number;
  samples?: Float32Array;
}

/** Runs the worklet source in a fake AudioWorkletGlobalScope. */
function load() {
  const scope = {
    currentFrame: 0,
    registered: new Map<string, new (o: unknown) => unknown>(),
  };
  class AudioWorkletProcessor {
    port = {
      posted: [] as Posted[],
      onmessage: null as ((e: { data: unknown }) => void) | null,
      postMessage(m: Posted) {
        this.posted.push(m);
      },
    };
  }
  const globals = {
    AudioWorkletProcessor,
    registerProcessor: (name: string, cls: new (o: unknown) => unknown) => scope.registered.set(name, cls),
    get currentFrame() {
      return scope.currentFrame;
    },
  };
  new Function("g", `with (g) { ${CAPTURE_WORKLET_SOURCE} }`)(globals);
  const Cls = scope.registered.get(CAPTURE_PROCESSOR)!;
  type Proc = {
    port: AudioWorkletProcessor["port"];
    process(inputs: Float32Array[][]): boolean;
  };
  const proc = new Cls({ processorOptions: { batchFrames: 384 } }) as Proc;
  const run = (input: Float32Array[][]) => {
    const r = proc.process(input);
    scope.currentFrame += 128;
    return r;
  };
  return { scope, proc, run };
}

const quantum = (v: number) => new Float32Array(128).fill(v);

describe("capture worklet", () => {
  it("registers and posts contiguous batches tagged with their first context frame", () => {
    const { proc, run, scope } = load();
    scope.currentFrame = 1280;
    for (let i = 0; i < 7; i++) expect(run([[quantum(i)]])).toBe(true);
    const pcm = proc.port.posted.filter((m) => m.type === "pcm");
    expect(pcm.map((m) => m.frame)).toEqual([1280, 1280 + 384]);
    expect(Array.from(pcm[0]!.samples!.subarray(126, 130))).toEqual([0, 0, 1, 1]);
    expect(pcm[1]!.samples!.length).toBe(384);
  });

  it("records a quantum without input channels as silence", () => {
    const { proc, run } = load();
    run([[quantum(0.5)]]);
    run([[]]);
    run([]);
    const [m] = proc.port.posted;
    expect(m!.samples!.length).toBe(384);
    expect(m!.samples![127]).toBe(0.5);
    expect(m!.samples![128]).toBe(0);
  });

  it("starts a new batch at a frame gap", () => {
    const { proc, run, scope } = load();
    run([[quantum(1)]]);
    scope.currentFrame += 1000;
    run([[quantum(2)]]);
    proc.port.onmessage!({ data: { type: "close" } });
    expect(proc.port.posted.map((m) => [m.type, m.frame, m.samples?.length])).toEqual([
      ["pcm", 0, 128],
      ["pcm", 1128, 128],
      ["closed", undefined, undefined],
    ]);
  });

  it("flushes the partial batch on close, then ends", () => {
    const { proc, run } = load();
    run([[quantum(1)]]);
    proc.port.onmessage!({ data: { type: "close" } });
    proc.port.onmessage!({ data: { type: "close" } });
    expect(proc.port.posted.map((m) => m.type)).toEqual(["pcm", "closed"]);
    expect(run([[quantum(1)]])).toBe(false);
  });

  it("sizes batches to ~40 ms of whole render quanta", () => {
    expect(batchFramesFor(48000)).toBe(1920);
    expect(batchFramesFor(44100)).toBe(1792);
    expect(batchFramesFor(8000) % 128).toBe(0);
  });
});
