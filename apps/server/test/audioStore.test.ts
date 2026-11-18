import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, truncateSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  HEADER_BYTES,
  MAGIC,
  newFileKey,
  RECORD_OVERHEAD_BYTES,
  RECORD_PREFIX_BYTES,
} from "../src/audio/crypto";
import {
  type AudioFileStore as AFS,
  AudioFileError,
  AudioFileStore,
  type AudioReadIssue,
} from "../src/audio/fileStore";
import { pcmChunk } from "./audioFixtures";
import { cleanup } from "./harness";

const SESSION = "S-20261118-TEST";

async function collect(files: AFS, fileName: string, key: Buffer, sessionId = SESSION) {
  const issues: AudioReadIssue[] = [];
  const records: Array<{ seq: number; data: Buffer }> = [];
  for await (const r of files.readRecords(sessionId, fileName, key, { onIssue: (i) => issues.push(i) }))
    records.push({ seq: r.seq, data: r.data });
  return { records, issues };
}

describe("encrypted audio file store", () => {
  let dir: string;
  let files: AudioFileStore;
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "wkwa-audio-"));
    files = new AudioFileStore(path.join(dir, "audio"));
  });
  afterEach(() => cleanup(dir));

  it("round-trips records in file order and reassembles PCM by seq", async () => {
    const { fileName, key } = await files.createFile(SESSION);
    expect(fileName).toMatch(/^[0-9a-f]{32}\.wka$/);
    expect(key).toHaveLength(32);
    const chunks = [0, 1, 2, 3].map((s) => pcmChunk(1600, s));
    // out of order, as after a reconnect
    for (const seq of [0, 2, 1, 3]) await files.appendRecord(SESSION, fileName, key, seq, chunks[seq]!);
    const { records, issues } = await collect(files, fileName, key);
    expect(issues).toEqual([]);
    expect(records.map((r) => r.seq)).toEqual([0, 2, 1, 3]);
    expect(records[1]!.data.equals(chunks[2]!)).toBe(true);

    const { pcm, seqs, duplicates } = await files.readTrackPcm(SESSION, fileName, key);
    expect(seqs).toEqual([0, 1, 2, 3]);
    expect(duplicates).toBe(0);
    expect(pcm.equals(Buffer.concat(chunks))).toBe(true);
    const v = await files.verifyFile(SESSION, fileName, key);
    expect(v).toMatchObject({ exists: true, ok: true, records: 4, firstError: null, truncatedTailBytes: 0 });
  });

  it("keeps the first copy of a chunk the client sent twice", async () => {
    const { fileName, key } = await files.createFile(SESSION);
    const a = pcmChunk(800, 1);
    await files.appendRecord(SESSION, fileName, key, 0, pcmChunk(800, 0));
    await files.appendRecord(SESSION, fileName, key, 1, a);
    await files.appendRecord(SESSION, fileName, key, 1, pcmChunk(800, 5)); // a resend (different bytes, to tell them apart)
    const r = await files.readTrackChunks(SESSION, fileName, key);
    expect(r.chunks.map((c) => c.seq)).toEqual([0, 1]);
    expect(r.chunks[1]!.data.equals(a)).toBe(true);
    expect(r.duplicates).toBe(1);
  });

  it("serialises concurrent appends to one file", async () => {
    const { fileName, key } = await files.createFile(SESSION);
    const chunks = Array.from({ length: 25 }, (_, i) => pcmChunk(400, i));
    await Promise.all(chunks.map((c, seq) => files.appendRecord(SESSION, fileName, key, seq, c)));
    const { records, issues } = await collect(files, fileName, key);
    expect(issues).toEqual([]);
    expect(records.map((r) => r.seq)).toEqual(chunks.map((_, i) => i));
  });

  it("stores no plaintext: no RIFF/OggS magic, no PCM pattern, no silence", async () => {
    const { fileName, key } = await files.createFile(SESSION);
    const wavHeader = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WAVEfmt ")]);
    const ogg = Buffer.from("OggS\0\x02");
    const pcm = pcmChunk(80_000, 3); // one full 5 s chunk (160 KB)
    await files.appendRecord(SESSION, fileName, key, 0, Buffer.concat([wavHeader, pcm]));
    await files.appendRecord(SESSION, fileName, key, 1, Buffer.concat([ogg, pcm]));
    const raw = readFileSync(files.pathOf(SESSION, fileName));
    expect(raw.subarray(0, 4).equals(MAGIC)).toBe(true);
    expect(raw.length).toBe(
      HEADER_BYTES + 2 * RECORD_OVERHEAD_BYTES + wavHeader.length + ogg.length + 2 * pcm.length,
    );
    for (const magic of ["RIFF", "WAVE", "OggS", "fmt "])
      expect(raw.includes(Buffer.from(magic))).toBe(false);
    expect(raw.includes(Buffer.alloc(32))).toBe(false); // the digital silence in the middle of the tone
    for (let i = 0; i < pcm.length - 32; i += 1601) expect(raw.includes(pcm.subarray(i, i + 32))).toBe(false);
    // ciphertext looks random: every byte value appears, none dominates
    const hist = new Array<number>(256).fill(0);
    for (const b of raw.subarray(HEADER_BYTES)) hist[b]!++;
    expect(Math.max(...hist) / (raw.length / 256)).toBeLessThan(1.3);
  });

  it("detects a flipped byte and skips only that record", async () => {
    const { fileName, key } = await files.createFile(SESSION);
    for (let seq = 0; seq < 3; seq++)
      await files.appendRecord(SESSION, fileName, key, seq, pcmChunk(1000, seq));
    const file = files.pathOf(SESSION, fileName);
    const raw = readFileSync(file);
    const second = HEADER_BYTES + RECORD_OVERHEAD_BYTES + 2000; // start of record seq 1
    raw[second + RECORD_PREFIX_BYTES + 12 + 100]! ^= 0x01; // a ciphertext byte
    writeFileSync(file, raw);

    const { records, issues } = await collect(files, fileName, key);
    expect(records.map((r) => r.seq)).toEqual([0, 2]);
    expect(issues).toMatchObject([{ kind: "tag_mismatch", seq: 1, offset: second }]);
    const v = await files.verifyFile(SESSION, fileName, key);
    expect(v.ok).toBe(false);
    expect(v.firstError).toContain("failed authentication");
    // without onIssue a strict reader throws
    await expect(async () => {
      for await (const _ of files.readRecords(SESSION, fileName, key));
    }).rejects.toThrow(AudioFileError);
    expect((await files.readTrackPcm(SESSION, fileName, key)).seqs).toEqual([0, 2]);
  });

  it("refuses renumbered records and records moved from another file", async () => {
    const a = await files.createFile(SESSION);
    const b = await files.createFile(SESSION);
    await files.appendRecord(SESSION, a.fileName, a.key, 7, pcmChunk(500));
    const fileA = files.pathOf(SESSION, a.fileName);
    const rec = readFileSync(fileA).subarray(HEADER_BYTES);
    // renumber seq 7 → 8 in place
    const renumbered = Buffer.from(rec);
    renumbered.writeUInt32BE(8, 4);
    writeFileSync(fileA, Buffer.concat([readFileSync(fileA).subarray(0, HEADER_BYTES), renumbered]));
    expect((await collect(files, a.fileName, a.key)).issues[0]?.kind).toBe("tag_mismatch");
    // the original record copied into file b (even with b's key it cannot verify: fileId is in the AAD)
    appendFileSync(files.pathOf(SESSION, b.fileName), rec);
    expect((await collect(files, b.fileName, a.key)).issues[0]?.kind).toBe("tag_mismatch");
    expect((await collect(files, b.fileName, b.key)).issues[0]?.kind).toBe("tag_mismatch");
  });

  it("reads nothing with the wrong key", async () => {
    const { fileName, key } = await files.createFile(SESSION);
    await files.appendRecord(SESSION, fileName, key, 0, pcmChunk(500));
    const { records, issues } = await collect(files, fileName, newFileKey());
    expect(records).toEqual([]);
    expect(issues.map((i) => i.kind)).toEqual(["tag_mismatch"]);
    expect((await files.verifyFile(SESSION, fileName, newFileKey())).ok).toBe(false);
  });

  it("tolerates an incomplete last record (crash mid-write) and repairs it on the next append", async () => {
    const { fileName, key } = await files.createFile(SESSION);
    for (let seq = 0; seq < 3; seq++)
      await files.appendRecord(SESSION, fileName, key, seq, pcmChunk(1000, seq));
    const file = files.pathOf(SESSION, fileName);
    const full = readFileSync(file).length;
    truncateSync(file, full - 50);

    const { records, issues } = await collect(files, fileName, key);
    expect(records.map((r) => r.seq)).toEqual([0, 1]);
    expect(issues).toMatchObject([{ kind: "truncated", bytes: RECORD_OVERHEAD_BYTES + 2000 - 50 }]);
    // a strict reader does not throw for a truncated tail
    const strict: number[] = [];
    for await (const r of files.readRecords(SESSION, fileName, key)) strict.push(r.seq);
    expect(strict).toEqual([0, 1]);
    const v = await files.verifyFile(SESSION, fileName, key);
    expect(v).toMatchObject({ ok: true, records: 2, truncatedTailBytes: RECORD_OVERHEAD_BYTES + 2000 - 50 });

    // the server restarts (new store instance) and the client resends seq 2
    const restarted = new AudioFileStore(files.root);
    const res = await restarted.appendRecord(SESSION, fileName, key, 2, pcmChunk(1000, 2));
    expect(res.droppedTailBytes).toBe(RECORD_OVERHEAD_BYTES + 2000 - 50);
    const after = await restarted.verifyFile(SESSION, fileName, key);
    expect(after).toMatchObject({ ok: true, records: 3, truncatedTailBytes: 0, seqs: [0, 1, 2] });
    // a tail shorter than a record prefix is handled too
    appendFileSync(file, Buffer.from([1, 2, 3]));
    expect((await collect(files, fileName, key)).issues).toMatchObject([{ kind: "truncated", bytes: 3 }]);
  });

  it("reports a bad header or a missing file instead of reading garbage", async () => {
    const { fileName, key } = await files.createFile(SESSION);
    const file = files.pathOf(SESSION, fileName);
    writeFileSync(file, Buffer.concat([Buffer.from("RIFX"), readFileSync(file).subarray(4)]));
    expect((await files.verifyFile(SESSION, fileName, key)).firstError).toContain("bad magic");
    await expect(files.appendRecord(SESSION, fileName, key, 0, pcmChunk(10))).rejects.toThrow(AudioFileError);
    const missing = await files.verifyFile(SESSION, `${"0".repeat(32)}.wka`, key);
    expect(missing).toMatchObject({ exists: false, ok: false });
  });

  it("rejects path tricks in session ids and file names", async () => {
    await expect(files.createFile("../escape")).rejects.toThrow(AudioFileError);
    await expect(files.createFile("S-1/../../x")).rejects.toThrow(AudioFileError);
    expect(() => files.pathOf(SESSION, "../../wkwa.db")).toThrow(AudioFileError);
    expect(() => files.deleteSessionDir("..")).toThrow(AudioFileError);
    expect(() => files.pathOf(SESSION, "WK-7F3K-Q9XM-4.wka")).toThrow(AudioFileError);
  });

  it("deletes files and session folders; a late append never recreates a deleted file", async () => {
    const { fileName, key } = await files.createFile(SESSION);
    await files.appendRecord(SESSION, fileName, key, 0, pcmChunk(10));
    expect(files.deleteFile(SESSION, fileName)).toBe(true);
    expect(files.deleteFile(SESSION, fileName)).toBe(false);
    await expect(files.appendRecord(SESSION, fileName, key, 1, pcmChunk(10))).rejects.toThrow();
    expect(files.exists(SESSION, fileName)).toBe(false);

    await files.createFile(SESSION);
    await files.createFile("S-20261118-OTHR");
    expect(files.deleteSessionDir(SESSION)).toEqual({ removed: true, files: 1 });
    expect(files.deleteSessionDir(SESSION)).toEqual({ removed: false, files: 0 });
    expect(files.listFiles().map((f) => f.sessionId)).toEqual(["S-20261118-OTHR"]);
  });

  it("lists files and finds orphans", async () => {
    const a = await files.createFile(SESSION);
    const b = await files.createFile(SESSION);
    mkdirSync(path.join(files.root, "stray"), { recursive: true });
    writeFileSync(path.join(files.root, "stray", "notes.txt"), "x");
    writeFileSync(path.join(files.root, "loose.wav"), "x");
    const all = files.listFiles();
    expect(all).toHaveLength(4);
    const orphans = files.findOrphans([{ sessionId: SESSION, fileName: a.fileName }]);
    expect(orphans.map((o) => o.relPath).sort()).toEqual(
      [`${SESSION}/${b.fileName}`, "loose.wav", "stray/notes.txt"].sort(),
    );
    expect(orphans.find((o) => o.relPath === "loose.wav")?.sessionId).toBeNull();
  });

  it("copies the whole folder for a backup", async () => {
    const { fileName, key } = await files.createFile(SESSION);
    await files.appendRecord(SESSION, fileName, key, 0, pcmChunk(100));
    const target = path.join(dir, "backup.db.audio");
    const r = files.copyTo(target);
    expect(r.files).toBe(1);
    const copy = new AudioFileStore(target);
    expect((await copy.verifyFile(SESSION, fileName, key)).ok).toBe(true);
    expect(() => files.copyTo(target)).toThrow(AudioFileError);
  });
});
