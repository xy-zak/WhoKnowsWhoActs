/**
 * Silero VAD (v6, MIT licence, https://github.com/snakers4/silero-vad) on ONNX Runtime.
 *
 * The model file ships in the repository (`apps/server/models/silero_vad.onnx`, ≈ 2.3 MB) and is
 * checked against its SHA-256 before use, so the install stays offline and reproducible. It scores
 * 32 ms windows (512 samples at 16 kHz) with 64 samples of context and a recurrent state; about
 * 0.1 ms per window on one CPU thread, ≈ 12 s per hour of one seat.
 *
 * It answers "is this speech?" only: no embeddings, no voiceprints, no speaker identity.
 * `onnxruntime-node` is loaded on demand, so the game server never loads it; only the attribution
 * worker does.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Vad } from "./features";

export const SILERO_MODEL_PATH = fileURLToPath(new URL("../../../models/silero_vad.onnx", import.meta.url));
export const SILERO_SHA256 = "1a153a22f4509e292a94e67d6f9b85e8deb25b4988682b7e174c65279d8788e3";
export const SILERO_NAME = "silero-vad 6.2.3";

const WINDOW = 512;
const CONTEXT = 64;

/** Loads the model (one thread). Throws when the runtime or the model is missing or altered. */
export async function loadSilero(modelPath = SILERO_MODEL_PATH): Promise<Vad> {
  const bytes = readFileSync(modelPath);
  const sha = createHash("sha256").update(bytes).digest("hex");
  if (sha !== SILERO_SHA256) throw new Error(`The speech model ${modelPath} has an unexpected checksum`);
  const ort = (await import("onnxruntime-node")).default;
  const session = await ort.InferenceSession.create(bytes, { intraOpNumThreads: 1, interOpNumThreads: 1 });
  const sr = new ort.Tensor("int64", BigInt64Array.from([16000n]), []);
  const input = new Float32Array(CONTEXT + WINDOW);
  let state = new ort.Tensor("float32", new Float32Array(2 * 128), [2, 1, 128]);
  const reset = () => {
    state = new ort.Tensor("float32", new Float32Array(2 * 128), [2, 1, 128]);
    input.fill(0);
  };
  return {
    windowSamples: WINDOW,
    reset,
    async next(window) {
      input.copyWithin(0, WINDOW); // the previous window's last 64 samples are the context
      input.set(window, CONTEXT);
      const out = await session.run({
        input: new ort.Tensor("float32", input, [1, CONTEXT + WINDOW]),
        state,
        sr,
      });
      state = out.stateN as typeof state;
      return (out.output!.data as Float32Array)[0]!;
    },
  };
}
