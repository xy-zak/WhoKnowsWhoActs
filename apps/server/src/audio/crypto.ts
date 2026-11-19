/**
 * The `.wka` container: append-only records, each sealed with AES-256-GCM.
 *
 *   header  = "WKA1" (4 bytes) | format version (u16 BE) | fileId (16 bytes)
 *   record  = payloadLen (u32 BE) | seq (u32 BE) | nonce (12 bytes) | ciphertext (payloadLen) | tag (16 bytes)
 *   AAD     = fileId | seq (u32 BE)
 *
 * Every file has its own random 32-byte key, kept only in the SQLCipher
 * database (never next to the file). The fileId in the AAD binds a record to
 * its file and the seq to its position in the stream, so records cannot be
 * moved between files or renumbered without the tag failing. Each record has
 * a fresh random nonce; with one key per file and a few thousand records per
 * file, nonce reuse is not a practical risk.
 *
 * Only node:crypto is used: no third-party cryptography.
 */
import { createCipheriv, createDecipheriv, randomBytes, randomFillSync } from "node:crypto";

export const MAGIC = Buffer.from("WKA1", "ascii");
export const FORMAT_VERSION = 1;
export const KEY_BYTES = 32;
export const FILE_ID_BYTES = 16;
export const NONCE_BYTES = 12;
export const TAG_BYTES = 16;
/** magic + version + fileId */
export const HEADER_BYTES = MAGIC.length + 2 + FILE_ID_BYTES;
/** payloadLen + seq */
export const RECORD_PREFIX_BYTES = 8;
/** Everything in a record except the ciphertext. */
export const RECORD_OVERHEAD_BYTES = RECORD_PREFIX_BYTES + NONCE_BYTES + TAG_BYTES;
/**
 * Largest payload per record. A 5 s chunk of 16 kHz mono s16le is 160 KB;
 * anything far above this limit is a corrupt length field, not a record.
 */
export const MAX_RECORD_PAYLOAD_BYTES = 8 * 1024 * 1024;
export const MAX_SEQ = 0xffff_ffff;

const CIPHER = "aes-256-gcm";

/** A fresh random file key (32 bytes, AES-256). */
export function newFileKey(): Buffer {
  return randomBytes(KEY_BYTES);
}

/** A fresh random file id (16 bytes); its hex form is the file name. */
export function newFileId(): Buffer {
  return randomBytes(FILE_ID_BYTES);
}

export function encodeHeader(fileId: Buffer): Buffer {
  if (fileId.length !== FILE_ID_BYTES) throw new Error(`fileId must be ${FILE_ID_BYTES} bytes`);
  const h = Buffer.alloc(HEADER_BYTES);
  MAGIC.copy(h, 0);
  h.writeUInt16BE(FORMAT_VERSION, MAGIC.length);
  fileId.copy(h, MAGIC.length + 2);
  return h;
}

/** Parse a header; returns a reason string when it is not a valid `.wka` header. */
export function decodeHeader(h: Buffer): { version: number; fileId: Buffer } | string {
  if (h.length < HEADER_BYTES) return "file shorter than the header";
  if (!h.subarray(0, MAGIC.length).equals(MAGIC)) return "not a WKA1 file (bad magic)";
  const version = h.readUInt16BE(MAGIC.length);
  if (version !== FORMAT_VERSION) return `unsupported format version ${version}`;
  return { version, fileId: Buffer.from(h.subarray(MAGIC.length + 2, HEADER_BYTES)) };
}

export function recordAad(fileId: Buffer, seq: number): Buffer {
  const aad = Buffer.alloc(FILE_ID_BYTES + 4);
  fileId.copy(aad, 0);
  aad.writeUInt32BE(seq, FILE_ID_BYTES);
  return aad;
}

function checkKey(key: Buffer) {
  if (!Buffer.isBuffer(key) || key.length !== KEY_BYTES)
    throw new Error(`file key must be ${KEY_BYTES} bytes`);
}

function checkSeq(seq: number) {
  if (!Number.isInteger(seq) || seq < 0 || seq > MAX_SEQ)
    throw new Error(`seq must be an integer 0…${MAX_SEQ}`);
}

/** Encrypt one record and return its complete on-disk bytes. */
export function encodeRecord(key: Buffer, fileId: Buffer, seq: number, plaintext: Buffer): Buffer {
  checkKey(key);
  checkSeq(seq);
  if (plaintext.length > MAX_RECORD_PAYLOAD_BYTES)
    throw new Error(`record payload over ${MAX_RECORD_PAYLOAD_BYTES} bytes`);
  // payloadLen | seq | nonce | ciphertext | tag, written into one buffer (GCM: ciphertext length = plaintext length)
  const out = Buffer.allocUnsafe(RECORD_OVERHEAD_BYTES + plaintext.length);
  out.writeUInt32BE(plaintext.length, 0);
  out.writeUInt32BE(seq, 4);
  const nonce = randomFillSync(out.subarray(RECORD_PREFIX_BYTES, RECORD_PREFIX_BYTES + NONCE_BYTES));
  const cipher = createCipheriv(CIPHER, key, nonce, { authTagLength: TAG_BYTES });
  cipher.setAAD(recordAad(fileId, seq));
  let off = RECORD_PREFIX_BYTES + NONCE_BYTES;
  off += cipher.update(plaintext).copy(out, off);
  off += cipher.final().copy(out, off);
  cipher.getAuthTag().copy(out, off);
  return out;
}

/**
 * Decrypt the part of a record after its prefix (nonce | ciphertext | tag).
 * Returns null when the tag does not verify: tampered bytes, the wrong key,
 * a record from another file, or a renumbered seq.
 */
export function decodeRecordBody(key: Buffer, fileId: Buffer, seq: number, body: Buffer): Buffer | null {
  checkKey(key);
  if (body.length < NONCE_BYTES + TAG_BYTES) return null;
  const nonce = body.subarray(0, NONCE_BYTES);
  const ct = body.subarray(NONCE_BYTES, body.length - TAG_BYTES);
  const tag = body.subarray(body.length - TAG_BYTES);
  try {
    const d = createDecipheriv(CIPHER, key, nonce, { authTagLength: TAG_BYTES });
    d.setAAD(recordAad(fileId, seq));
    d.setAuthTag(tag);
    return Buffer.concat([d.update(ct), d.final()]);
  } catch {
    return null;
  }
}
