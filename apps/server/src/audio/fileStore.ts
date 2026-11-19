/**
 * Encrypted audio files: `data/audio/<sessionId>/<fileId>.wka`.
 *
 * Each file is an append-only `.wka` container (see ./crypto.ts) encrypted
 * with its own random key. The key and every piece of metadata live in the
 * SQLCipher database (audio_tracks / audio_derivatives), so:
 *  - erasure deletes the key row and unlinks the file: even a leaked copy of
 *    the file is unreadable (crypto-shredding);
 *  - changing the database passphrase (rekey) needs no file re-encryption;
 *  - a backup is the database copy plus a copy of this folder.
 *
 * File names are random (16 bytes, hex) and never contain participant codes:
 * codes live only in the `participant_code` columns.
 */
import { cpSync, existsSync, readdirSync, rmSync, statSync, unlinkSync } from "node:fs";
import { type FileHandle, mkdir, open } from "node:fs/promises";
import path from "node:path";
import { AUDIO_ENGINE_FILE_EXT } from "@wkwa/shared";
import {
  decodeHeader,
  decodeRecordBody,
  encodeHeader,
  encodeRecord,
  FILE_ID_BYTES,
  HEADER_BYTES,
  MAX_RECORD_PAYLOAD_BYTES,
  newFileId,
  newFileKey,
  RECORD_OVERHEAD_BYTES,
  RECORD_PREFIX_BYTES,
} from "./crypto";

/** Name of the audio folder inside the data directory. */
export const AUDIO_DIR_NAME = "audio";

export function audioDirOf(dataDir: string): string {
  return path.join(dataDir, AUDIO_DIR_NAME);
}

const FILE_NAME_PATTERN = new RegExp(`^[0-9a-f]{${FILE_ID_BYTES * 2}}\\${AUDIO_ENGINE_FILE_EXT}$`);
/** Session ids are `S-YYYYMMDD-XXXX` / `SIM-…`; anything path-like is refused. */
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export class AudioFileError extends Error {}

/** Something found while reading a file. Reads report these instead of throwing (see readRecords). */
export type AudioReadIssue =
  | { kind: "missing"; message: string }
  | { kind: "bad_header"; message: string }
  /** The tag did not verify: tampered bytes, the wrong key, or a record moved/renumbered. */
  | { kind: "tag_mismatch"; offset: number; seq: number; message: string }
  /** A length field over the limit: the file is corrupt from here on. */
  | { kind: "bad_length"; offset: number; length: number; message: string }
  /** The last record is incomplete (crash mid-write). Earlier records are intact. */
  | { kind: "truncated"; offset: number; bytes: number; message: string };

export interface AudioRecord {
  seq: number;
  /** Byte offset of the record in the file. */
  offset: number;
  data: Buffer;
}

export interface AppendResult {
  /** Bytes written to the file for this record (payload + 36 bytes of framing). */
  bytes: number;
  /** Bytes of an incomplete last record (left by a crash) removed before appending; normally 0. */
  droppedTailBytes: number;
}

export interface VerifyResult {
  exists: boolean;
  /** True when the header and every complete record verify (a truncated tail is reported separately). */
  ok: boolean;
  /** Records whose tag verified. */
  records: number;
  /** The first integrity problem, or null. */
  firstError: string | null;
  /** Size of an incomplete last record (crash mid-write), 0 if none. */
  truncatedTailBytes: number;
  /** The seq numbers of the valid records, in file order (duplicates included). */
  seqs: number[];
  issues: AudioReadIssue[];
}

export interface AudioFileInfo {
  /** The session folder, or null for a file outside any session folder. */
  sessionId: string | null;
  fileName: string;
  /** Path relative to the audio folder, with forward slashes (`<sessionId>/<fileName>`). */
  relPath: string;
  bytes: number;
}

function fileIdOf(fileName: string): Buffer {
  return Buffer.from(fileName.slice(0, FILE_ID_BYTES * 2), "hex");
}

async function readExactly(fh: FileHandle, length: number, position: number): Promise<Buffer> {
  const buf = Buffer.alloc(length);
  let done = 0;
  while (done < length) {
    const { bytesRead } = await fh.read(buf, done, length - done, position + done);
    if (bytesRead === 0) throw new AudioFileError("unexpected end of file");
    done += bytesRead;
  }
  return buf;
}

async function writeAll(fh: FileHandle, buf: Buffer, position: number) {
  let done = 0;
  while (done < buf.length) {
    const { bytesWritten } = await fh.write(buf, done, buf.length - done, position + done);
    done += bytesWritten;
  }
}

/** fsync a directory so a new entry survives a crash (not possible on every platform: best effort). */
async function syncDir(dir: string) {
  let fh: FileHandle | null = null;
  try {
    fh = await open(dir, "r");
    await fh.sync();
  } catch {
    // e.g. Windows cannot open directories
  } finally {
    await fh?.close().catch(() => {});
  }
}

export class AudioFileStore {
  /** Serialised write queue per file (absolute path → tail of the queue). */
  private queues = new Map<string, Promise<unknown>>();
  /** Known end of the last complete record per file, to append without rescanning. */
  private ends = new Map<string, number>();

  constructor(readonly root: string) {}

  /* ─────────── paths ─────────── */

  private checkSessionId(sessionId: string) {
    if (!SESSION_ID_PATTERN.test(sessionId))
      throw new AudioFileError(`Invalid session id for audio: ${sessionId}`);
  }

  private checkFileName(fileName: string) {
    if (!FILE_NAME_PATTERN.test(fileName)) throw new AudioFileError(`Invalid audio file name: ${fileName}`);
  }

  /** Absolute folder of a session's audio, guaranteed to be inside the audio folder. */
  sessionDir(sessionId: string): string {
    this.checkSessionId(sessionId);
    const dir = path.resolve(this.root, sessionId);
    if (!dir.startsWith(path.resolve(this.root) + path.sep))
      throw new AudioFileError(`Audio folder of ${sessionId} would be outside ${this.root}`);
    return dir;
  }

  /** Absolute path of one file (validated: no path tricks). */
  pathOf(sessionId: string, fileName: string): string {
    this.checkFileName(fileName);
    return path.join(this.sessionDir(sessionId), fileName);
  }

  exists(sessionId: string, fileName: string): boolean {
    return existsSync(this.pathOf(sessionId, fileName));
  }

  /* ─────────── writing ─────────── */

  /** Create an empty file (header only) with a fresh random name and key. Store the key in the database. */
  async createFile(sessionId: string): Promise<{ fileName: string; key: Buffer }> {
    const dir = this.sessionDir(sessionId);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const fileId = newFileId();
    const fileName = `${fileId.toString("hex")}${AUDIO_ENGINE_FILE_EXT}`;
    const file = path.join(dir, fileName);
    const fh = await open(file, "wx", 0o600);
    try {
      await writeAll(fh, encodeHeader(fileId), 0);
      await fh.sync();
    } finally {
      await fh.close();
    }
    await syncDir(dir);
    this.ends.set(file, HEADER_BYTES);
    return { fileName, key: newFileKey() };
  }

  /**
   * Append one encrypted record. Appends to the same file run one at a time
   * (in call order), and each is flushed with fdatasync before it resolves,
   * so an acknowledged chunk is on disk. An incomplete last record left by a
   * crash is cut off before the new record is written. The file must exist
   * (createFile): a deleted file is never recreated by a late append.
   */
  appendRecord(
    sessionId: string,
    fileName: string,
    key: Buffer,
    seq: number,
    data: Buffer,
  ): Promise<AppendResult> {
    let file: string;
    let record: Buffer;
    try {
      file = this.pathOf(sessionId, fileName);
      record = encodeRecord(key, fileIdOf(fileName), seq, data);
    } catch (e) {
      return Promise.reject(e);
    }
    const prev = this.queues.get(file) ?? Promise.resolve();
    const run = prev.then(() => this.writeRecord(file, fileName, record));
    const tail = run.catch(() => {});
    this.queues.set(file, tail);
    void tail.then(() => {
      if (this.queues.get(file) === tail) this.queues.delete(file);
    });
    return run;
  }

  private async writeRecord(file: string, fileName: string, record: Buffer): Promise<AppendResult> {
    const fh = await open(file, "r+");
    try {
      const size = (await fh.stat()).size;
      let end = this.ends.get(file);
      let droppedTailBytes = 0;
      if (end !== size) {
        // first append in this process, or the file changed: check it is still this file's `.wka`
        // and find the end of the last complete record
        await this.checkHeader(fh, size, fileName);
        end = await this.scanEnd(fh, size, fileName);
        if (size > end) {
          await fh.truncate(end);
          droppedTailBytes = size - end;
        }
      }
      await writeAll(fh, record, end);
      await fh.datasync();
      this.ends.set(file, end + record.length);
      return { bytes: record.length, droppedTailBytes };
    } catch (e) {
      this.ends.delete(file);
      throw e;
    } finally {
      await fh.close();
    }
  }

  /** Refuse to append to a file whose header is not this file's `.wka` header. */
  private async checkHeader(fh: FileHandle, size: number, fileName: string) {
    if (size < HEADER_BYTES) throw new AudioFileError(`${fileName}: file shorter than its header`);
    const h = decodeHeader(await readExactly(fh, HEADER_BYTES, 0));
    if (typeof h === "string") throw new AudioFileError(`${fileName}: ${h}`);
    if (!h.fileId.equals(fileIdOf(fileName)))
      throw new AudioFileError(`${fileName}: header names another file`);
  }

  /**
   * Walk the record frames after the header (without decrypting) and return
   * the end of the last complete record. Refuses a file with a corrupt length
   * field: appending would bury the evidence.
   */
  private async scanEnd(fh: FileHandle, size: number, fileName: string): Promise<number> {
    let off = HEADER_BYTES;
    while (size - off >= RECORD_PREFIX_BYTES) {
      const len = (await readExactly(fh, 4, off)).readUInt32BE(0);
      if (len > MAX_RECORD_PAYLOAD_BYTES)
        throw new AudioFileError(`${fileName}: corrupt record length at byte ${off}; refusing to append`);
      if (size - off < RECORD_OVERHEAD_BYTES + len) break;
      off += RECORD_OVERHEAD_BYTES + len;
    }
    return off;
  }

  /* ─────────── reading ─────────── */

  /**
   * The valid records of a file, in file order, each tag verified.
   * Problems go to `onIssue` and the reader carries on where it can (a
   * truncated tail or a bad length ends the file). Without `onIssue`, a bad
   * header, a failed tag or a bad length throws AudioFileError; an incomplete
   * last record (crash mid-write) never throws.
   */
  async *readRecords(
    sessionId: string,
    fileName: string,
    key: Buffer,
    opts: { onIssue?: (issue: AudioReadIssue) => void } = {},
  ): AsyncGenerator<AudioRecord> {
    const file = this.pathOf(sessionId, fileName);
    const fileId = fileIdOf(fileName);
    const report = (issue: AudioReadIssue, fatal: boolean) => {
      if (opts.onIssue) opts.onIssue(issue);
      else if (fatal) throw new AudioFileError(`${fileName}: ${issue.message}`);
    };
    let fh: FileHandle;
    try {
      fh = await open(file, "r");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      report({ kind: "missing", message: "file not found" }, true);
      return;
    }
    try {
      const size = (await fh.stat()).size;
      const h =
        size < HEADER_BYTES
          ? "file shorter than the header"
          : decodeHeader(await readExactly(fh, HEADER_BYTES, 0));
      if (typeof h === "string" || !h.fileId.equals(fileId)) {
        report(
          { kind: "bad_header", message: typeof h === "string" ? h : "header names another file" },
          true,
        );
        return;
      }
      let off = HEADER_BYTES;
      while (off < size) {
        const rest = size - off;
        if (rest < RECORD_PREFIX_BYTES) {
          report(
            {
              kind: "truncated",
              offset: off,
              bytes: rest,
              message: `incomplete last record (${rest} bytes)`,
            },
            false,
          );
          return;
        }
        const prefix = await readExactly(fh, RECORD_PREFIX_BYTES, off);
        const len = prefix.readUInt32BE(0);
        const seq = prefix.readUInt32BE(4);
        if (len > MAX_RECORD_PAYLOAD_BYTES) {
          report(
            { kind: "bad_length", offset: off, length: len, message: `corrupt record length at byte ${off}` },
            true,
          );
          return;
        }
        const total = RECORD_OVERHEAD_BYTES + len;
        if (rest < total) {
          report(
            {
              kind: "truncated",
              offset: off,
              bytes: rest,
              message: `incomplete last record (${rest} bytes)`,
            },
            false,
          );
          return;
        }
        const body = await readExactly(fh, total - RECORD_PREFIX_BYTES, off + RECORD_PREFIX_BYTES);
        const data = decodeRecordBody(key, fileId, seq, body);
        if (data) yield { seq, offset: off, data };
        else
          report(
            {
              kind: "tag_mismatch",
              offset: off,
              seq,
              message: `record seq ${seq} at byte ${off} failed authentication`,
            },
            true,
          );
        off += total;
      }
    } finally {
      await fh.close();
    }
  }

  /**
   * Like readRecords, but only the first valid record of each seq, in file order: a chunk the
   * browser resent is stored twice, and the first copy wins. Same issue handling as readRecords.
   */
  async *readUniqueRecords(
    sessionId: string,
    fileName: string,
    key: Buffer,
    opts: { onIssue?: (issue: AudioReadIssue) => void } = {},
  ): AsyncGenerator<AudioRecord> {
    const seen = new Set<number>();
    for await (const r of this.readRecords(sessionId, fileName, key, opts)) {
      if (seen.has(r.seq)) continue;
      seen.add(r.seq);
      yield r;
    }
  }

  /** Check a file: header, every GCM tag, and the framing. */
  async verifyFile(sessionId: string, fileName: string, key: Buffer): Promise<VerifyResult> {
    const issues: AudioReadIssue[] = [];
    const seqs: number[] = [];
    for await (const r of this.readRecords(sessionId, fileName, key, { onIssue: (i) => issues.push(i) }))
      seqs.push(r.seq);
    const integrity = issues.filter((i) => i.kind !== "truncated");
    const tail = issues.find((i) => i.kind === "truncated");
    return {
      exists: !issues.some((i) => i.kind === "missing"),
      ok: integrity.length === 0,
      records: seqs.length,
      firstError: integrity[0]?.message ?? null,
      truncatedTailBytes: tail?.kind === "truncated" ? tail.bytes : 0,
      seqs,
      issues,
    };
  }

  /* ─────────── deleting ─────────── */

  /** Unlink one file. Returns false if it did not exist. A later append to it fails instead of recreating it. */
  deleteFile(sessionId: string, fileName: string): boolean {
    const file = this.pathOf(sessionId, fileName);
    this.ends.delete(file);
    try {
      unlinkSync(file);
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw e;
    }
  }

  /** Remove a session's whole audio folder (only ever inside the audio folder). */
  deleteSessionDir(sessionId: string): { removed: boolean; files: number } {
    // sessionDir() resolves the path and refuses anything outside the audio folder
    // (the same containment rule as gdpr/deleteSession.ts uses for export folders)
    const dir = this.sessionDir(sessionId);
    if (!existsSync(dir)) return { removed: false, files: 0 };
    const files: AudioFileInfo[] = [];
    this.walk(dir, [sessionId], files);
    for (const k of this.ends.keys()) if (k.startsWith(dir + path.sep)) this.ends.delete(k);
    rmSync(dir, { recursive: true, force: true });
    return { removed: true, files: files.length };
  }

  /* ─────────── listing ─────────── */

  private walk(dir: string, rel: string[], out: AudioFileInfo[]) {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) this.walk(abs, [...rel, e.name], out);
      else
        out.push({
          sessionId: rel.length === 1 ? rel[0]! : null,
          fileName: e.name,
          relPath: [...rel, e.name].join("/"),
          bytes: e.isFile() ? statSync(abs).size : 0,
        });
    }
  }

  /** Every file under the audio folder (any name, any depth). */
  listFiles(): AudioFileInfo[] {
    const out: AudioFileInfo[] = [];
    if (existsSync(this.root)) this.walk(this.root, [], out);
    return out.sort((a, b) => a.relPath.localeCompare(b.relPath));
  }

  /** Files on disk that no database row refers to (of `listed`, or of a fresh listFiles()). */
  findOrphans(
    known: Iterable<{ sessionId: string; fileName: string }>,
    listed: AudioFileInfo[] = this.listFiles(),
  ): AudioFileInfo[] {
    const k = new Set<string>();
    for (const f of known) k.add(`${f.sessionId}/${f.fileName}`);
    return listed.filter((f) => !k.has(f.relPath));
  }

  /** Copy the whole audio folder (for a backup). The target must not exist. */
  copyTo(target: string): { files: number; bytes: number } {
    if (existsSync(target)) throw new AudioFileError(`${target} already exists`);
    const files = this.listFiles();
    if (!existsSync(this.root)) return { files: 0, bytes: 0 };
    cpSync(this.root, target, { recursive: true, errorOnExist: true, force: false });
    return { files: files.length, bytes: files.reduce((n, f) => n + f.bytes, 0) };
  }
}
