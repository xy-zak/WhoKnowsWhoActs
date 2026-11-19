import type { Store } from "../db/store";
import { HEADER_BYTES, KEY_BYTES } from "./crypto";
import type { AudioFileInfo, AudioFileStore } from "./fileStore";

export interface AudioVerifyReport {
  /** Files checked (tracks with audio, and derivative files). */
  filesChecked: number;
  /** Records whose GCM tag verified. */
  records: number;
  /** Integrity problems (missing files, failed tags, keys kept after deletion, codes in names, orphans). */
  problems: string[];
  /** Worth knowing, not a fault (e.g. an incomplete last record left by a crash mid-write). */
  warnings: string[];
  /**
   * Files on disk that no database row refers to (also listed in `problems`, or in `warnings` when
   * the file is only a header: a crash between creating a track's file and storing its row).
   */
  orphans: AudioFileInfo[];
}

/** Participant-code look-alikes (WK-XXXX-XXXX-X, with or without dashes), whatever the case. */
const CODE_LIKE = /WK-?[0-9A-Z]{4}-?[0-9A-Z]{4}-?[0-9A-Z]/i;

/**
 * Check the encrypted audio store against the database:
 *  - every track with audio and every derivative file exists, has a key, and
 *    every record's GCM tag verifies; every chunk row has its record;
 *  - deleted raw audio has neither a key nor a file left;
 *  - no file on disk is unknown to the database (orphans);
 *  - no file or folder name contains a participant code.
 */
export async function verifyAudio(store: Store, files: AudioFileStore): Promise<AudioVerifyReport> {
  const report: AudioVerifyReport = { filesChecked: 0, records: 0, problems: [], warnings: [], orphans: [] };
  const problem = (m: string) => report.problems.push(m);
  const refs = store.audioFileRefs();
  const known: Array<{ sessionId: string; fileName: string }> = [];

  for (const ref of refs) {
    const label = `${ref.owner} ${ref.id} (${ref.sessionId}/${ref.fileName})`;
    let present: boolean;
    try {
      present = files.exists(ref.sessionId, ref.fileName);
    } catch (e) {
      problem(`${label}: ${(e as Error).message}`);
      continue;
    }
    if (ref.status === "deleted") {
      if (ref.key) problem(`${label}: raw audio marked deleted but its key is still stored`);
      if (present) {
        problem(`${label}: raw audio marked deleted but the file is still on disk`);
        known.push(ref);
      }
      continue;
    }
    known.push(ref);
    if (!ref.key || ref.key.length !== KEY_BYTES) {
      problem(`${label}: no valid key in the database`);
      continue;
    }
    if (!present) {
      problem(`${label}: file missing`);
      continue;
    }
    report.filesChecked++;
    const v = await files.verifyFile(ref.sessionId, ref.fileName, ref.key);
    report.records += v.records;
    if (!v.ok) problem(`${label}: ${v.firstError}`);
    if (v.truncatedTailBytes > 0)
      report.warnings.push(
        `${label}: incomplete last record (${v.truncatedTailBytes} bytes, crash mid-write?)`,
      );
    if (ref.owner === "track") {
      const inFile = new Set(v.seqs);
      const seqs = store.listAudioChunks(ref.id).map((c) => c.seq);
      const missing = seqs.filter((s) => !inFile.has(s));
      if (missing.length)
        problem(
          `${label}: ${missing.length} chunk(s) in the database have no valid record in the file (seq ${missing
            .slice(0, 5)
            .join(", ")}${missing.length > 5 ? ", …" : ""})`,
        );
    }
  }

  const listed = files.listFiles();
  report.orphans = files.findOrphans(known, listed);
  for (const o of report.orphans)
    if (o.bytes === HEADER_BYTES)
      report.warnings.push(`orphan file ${o.relPath} holds no audio (header only, crash at a track start?)`);
    else problem(`orphan file ${o.relPath} (${o.bytes} bytes): no database row refers to it`);

  // codes live only in participant_code columns, never in file or folder names
  const codeSet = new Set<string>();
  for (const c of store.participantCodes()) {
    codeSet.add(c.toUpperCase());
    codeSet.add(c.replace(/-/g, "").toUpperCase());
  }
  const codes = [...codeSet];
  for (const f of listed) {
    const name = f.relPath.toUpperCase();
    if (CODE_LIKE.test(name) || codes.some((c) => name.includes(c)))
      problem(`file name ${f.relPath} contains a participant code`);
  }
  return report;
}
