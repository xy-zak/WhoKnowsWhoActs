/**
 * WAV (RIFF, PCM) helpers for streaming audio out of the encrypted store.
 *
 * - `wavHeader(format, dataBytes)`: the canonical 44-byte header for a known data length, so a
 *   route can send `Content-Length` and then stream the samples (`renderedSampleCount` tells the
 *   length of a rendered track before rendering it).
 * - `wavStream(blocks, format, totalSamples)`: header + little-endian samples as one async stream
 *   of byte chunks, padded with silence or truncated to exactly `totalSamples`, so the header is
 *   always true.
 * - `WavWriter`: push-style writer for when the length is not known up front; it emits a header with
 *   a provisional length and `end()` returns the final header to patch in at offset 0.
 * - `parseWavHeader`: reads a header back (RIFF/WAVE, `fmt `, `data`, skipping other chunks), for
 *   tests and verification.
 *
 * Only 16-bit PCM is produced (the capture format); mono by default.
 */

export interface WavFormat {
  sampleRate: number;
  channels?: number;
  bitsPerSample?: 16;
}

export interface WavInfo {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  audioFormat: number;
  /** Byte offset of the first sample. */
  dataOffset: number;
  dataBytes: number;
  /** Samples per channel. */
  frames: number;
  durationMs: number;
  /** True when the header declares more data than the file holds (e.g. an unpatched stream header). */
  truncated: boolean;
}

export const WAV_HEADER_BYTES = 44;
const MAX_DATA_BYTES = 0xffff_ffff - 36;
const LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

/** The 44-byte header of a PCM WAV file with `dataBytes` of sample data. */
export function wavHeader(format: WavFormat, dataBytes: number): Uint8Array {
  const channels = format.channels ?? 1;
  const bits = format.bitsPerSample ?? 16;
  if (!Number.isInteger(dataBytes) || dataBytes < 0 || dataBytes > MAX_DATA_BYTES) {
    throw new Error(`WAV data length out of range: ${dataBytes}`);
  }
  const blockAlign = (channels * bits) / 8;
  const buf = new Uint8Array(WAV_HEADER_BYTES);
  const v = new DataView(buf.buffer);
  const ascii = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) buf[offset + i] = s.charCodeAt(i);
  };
  ascii(0, "RIFF");
  v.setUint32(4, 36 + dataBytes, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  v.setUint32(16, 16, true); // fmt chunk size
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, channels, true);
  v.setUint32(24, format.sampleRate, true);
  v.setUint32(28, format.sampleRate * blockAlign, true);
  v.setUint16(32, blockAlign, true);
  v.setUint16(34, bits, true);
  ascii(36, "data");
  v.setUint32(40, dataBytes, true);
  return buf;
}

/**
 * Parses a WAV header; throws when it is not a RIFF/WAVE file. Pass `fileBytes` (the whole file's
 * size) to clamp the data length to what is actually there; by default the header is trusted, so a
 * header-only buffer can be parsed.
 */
export function parseWavHeader(bytes: Uint8Array, fileBytes?: number): WavInfo {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (offset: number) => String.fromCharCode(...bytes.subarray(offset, offset + 4));
  if (bytes.byteLength < 12 || tag(0) !== "RIFF" || tag(8) !== "WAVE")
    throw new Error("not a RIFF/WAVE file");
  let offset = 12;
  let fmt: { audioFormat: number; channels: number; sampleRate: number; bits: number } | null = null;
  while (offset + 8 <= bytes.byteLength) {
    const id = tag(offset);
    const size = v.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === "fmt ") {
      if (size < 16 || body + 16 > bytes.byteLength) throw new Error("truncated fmt chunk");
      fmt = {
        audioFormat: v.getUint16(body, true),
        channels: v.getUint16(body + 2, true),
        sampleRate: v.getUint32(body + 4, true),
        bits: v.getUint16(body + 14, true),
      };
    } else if (id === "data") {
      if (!fmt) throw new Error("data chunk before fmt chunk");
      const available = fileBytes === undefined ? size : Math.max(0, fileBytes - body);
      const dataBytes = Math.min(size, available);
      const blockAlign = (fmt.channels * fmt.bits) / 8;
      const frames = blockAlign > 0 ? Math.floor(dataBytes / blockAlign) : 0;
      return {
        sampleRate: fmt.sampleRate,
        channels: fmt.channels,
        bitsPerSample: fmt.bits,
        audioFormat: fmt.audioFormat,
        dataOffset: body,
        dataBytes,
        frames,
        durationMs: fmt.sampleRate > 0 ? (frames / fmt.sampleRate) * 1000 : 0,
        truncated: dataBytes < size,
      };
    }
    offset = body + size + (size % 2); // chunks are word-aligned
  }
  throw new Error("no data chunk");
}

/** The samples as little-endian bytes (a view when the host is little-endian, else a swapped copy). */
export function pcm16Bytes(samples: Int16Array): Uint8Array {
  if (LITTLE_ENDIAN) return new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength);
  const out = new Uint8Array(samples.byteLength);
  const v = new DataView(out.buffer);
  for (let i = 0; i < samples.length; i++) v.setInt16(i * 2, samples[i]!, true);
  return out;
}

/**
 * Header plus exactly `totalSamples` samples (per channel) from `blocks`, as byte chunks ready to be
 * written to a socket or file. Missing samples at the end are silence; extra samples are dropped.
 */
export async function* wavStream(
  blocks: AsyncIterable<Int16Array> | Iterable<Int16Array>,
  format: WavFormat,
  totalSamples: number,
): AsyncGenerator<Uint8Array> {
  const channels = format.channels ?? 1;
  const totalValues = totalSamples * channels;
  yield wavHeader(format, totalValues * 2);
  let written = 0;
  for await (const block of blocks) {
    if (written >= totalValues) break;
    const take = Math.min(block.length, totalValues - written);
    yield pcm16Bytes(take === block.length ? block : block.subarray(0, take));
    written += take;
  }
  const silence = new Int16Array(16_384);
  while (written < totalValues) {
    const take = Math.min(silence.length, totalValues - written);
    yield pcm16Bytes(silence.subarray(0, take));
    written += take;
  }
}

/**
 * Push-style WAV writer. The constructor emits a header for `expectedSamples` (or the maximum
 * length when unknown, which most players accept for streams); `end()` returns the true header to
 * write at offset 0 of a seekable sink.
 */
export class WavWriter {
  private samples = 0;
  private readonly channels: number;

  constructor(
    private readonly sink: (bytes: Uint8Array) => void,
    private readonly format: WavFormat,
    expectedSamples?: number,
  ) {
    this.channels = format.channels ?? 1;
    const bytes =
      expectedSamples === undefined
        ? MAX_DATA_BYTES - (MAX_DATA_BYTES % 2)
        : expectedSamples * this.channels * 2;
    sink(wavHeader(format, bytes));
  }

  write(samples: Int16Array): void {
    if ((this.samples + samples.length) * 2 > MAX_DATA_BYTES) throw new Error("WAV file would exceed 4 GiB");
    this.sink(pcm16Bytes(samples));
    this.samples += samples.length;
  }

  /** Samples written so far (per channel). */
  get length(): number {
    return Math.floor(this.samples / this.channels);
  }

  end(): { header: Uint8Array; dataBytes: number } {
    const dataBytes = this.samples * 2;
    return { header: wavHeader(this.format, dataBytes), dataBytes };
  }
}

/** A complete in-memory WAV file. */
export function encodeWav(samples: Int16Array, format: WavFormat): Uint8Array {
  const header = wavHeader(format, samples.byteLength);
  const out = new Uint8Array(header.length + samples.byteLength);
  out.set(header, 0);
  out.set(pcm16Bytes(samples), header.length);
  return out;
}
