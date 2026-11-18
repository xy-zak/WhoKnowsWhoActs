import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  applyEvent,
  EXPORT_FILES,
  type ExportColumn,
  expandColumns,
  exportFile,
  fakeSeats,
  generateAnonymousId,
  initialState,
  mapScoreOf,
  type PayloadOf,
  pairingName,
  pairingText,
  parseCellId,
  parseSessionConfig,
  randomCrockford,
  reduceEvents,
  renderCodebook,
  type StoredEvent,
  type StoredTelemetry,
} from "@wkwa/shared";
import { speechSegmentsOf, trackViews } from "../audio/records";
import { type ScenarioLibrary, sha256 } from "../content";
import type { Store } from "../db/store";
import { nowTs, wall } from "../runtime";

export type ExportKind = "standard" | "anonymised";
/** Kinds in the export register: the two CSV exports and the separate "Export audio" action. */
export type RegisteredExportKind = ExportKind | "audio";

export interface ExportResult {
  exportId: string;
  kind: ExportKind;
  sessionId: string;
  dir: string;
  files: Array<{ name: string; rows: number; sha256: string }>;
  participants: number;
}

/* ─────────────────────────── CSV ─────────────────────────── */

function csvValue(v: unknown, col: ExportColumn): string {
  if (v === null || v === undefined) return "";
  let s: string;
  if (col.type === "bool01") s = v ? "1" : "0";
  else if (col.type === "seat-list") s = Array.isArray(v) ? v.join(" ") : String(v);
  else if (col.type === "json") s = typeof v === "string" ? v : JSON.stringify(v);
  else if (typeof v === "number") s = Number.isFinite(v) ? String(v) : "";
  else s = String(v);
  return /[",\r\n]/.test(s) || /^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(columns: ExportColumn[], rows: Array<Record<string, unknown>>): string {
  const head = columns.map((c) => c.name).join(",");
  const body = rows.map((r) => columns.map((c) => csvValue(r[c.name], c)).join(","));
  return `${[head, ...body].join("\n")}\n`;
}

/* ─────────────────────────── Export ─────────────────────────── */

function exportId(now: number): string {
  const d = new Date(now).toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
  return `E-${d}-${randomCrockford(4)}`;
}

/**
 * Write a complete export of one session following EXPORT_FILES
 * (packages/shared/src/exportColumns.ts) exactly. Anonymised exports replace
 * every participant code with a random A-XXXXXX id; the mapping only lives
 * in memory during this function and is never written anywhere.
 */
export function exportSession(
  deps: { store: Store; scenarios: ScenarioLibrary; exportsDir: string },
  sessionId: string,
  kind: ExportKind = "standard",
): ExportResult {
  const { store } = deps;
  const row = store.getSession(sessionId);
  if (!row) throw new Error(`Unknown session ${sessionId}`);
  const events = store.listEvents(sessionId);
  const telemetry = store.listTelemetry(sessionId);
  const final = reduceEvents(events);
  const now = nowTs();
  const id = exportId(now);
  const dirName = kind === "anonymised" ? `anon-${id}` : id;
  const dir = path.join(deps.exportsDir, sessionId, dirName);
  mkdirSync(dir, { recursive: true });

  let regionNames = new Map<string, string>();
  try {
    const sc = deps.scenarios.load(row.scenario_id);
    regionNames = new Map(sc.regions.map((r) => [r.id, r.name]));
  } catch {}

  // participant id mapping (identity for standard exports)
  const codes = new Set<string>();
  for (const e of events) if (e.participantCode) codes.add(e.participantCode);
  for (const t of telemetry) codes.add(t.participantCode);
  // audio metadata carries the code too (a participant can have audio rows and few events)
  const tracks = trackViews(store, sessionId).sort(
    (a, b) => a.row.seat - b.row.seat || a.row.startedServerTs - b.row.startedServerTs,
  );
  const speech = speechSegmentsOf(store, sessionId).segments;
  for (const t of tracks) codes.add(t.row.participantCode);
  for (const s of speech) if (s.participantCode) codes.add(s.participantCode);
  const anon = new Map<string, string>();
  if (kind === "anonymised") {
    const used = new Set<string>();
    for (const c of codes) {
      let a = generateAnonymousId();
      while (used.has(a)) a = generateAnonymousId();
      used.add(a);
      anon.set(c, a);
    }
  }
  const pid = (code: string | null | undefined) =>
    code ? (kind === "anonymised" ? (anon.get(code) ?? null) : code) : null;

  const written: ExportResult["files"] = [];
  const write = (name: string, content: string, rows: number) => {
    writeFileSync(path.join(dir, name), content);
    written.push({ name, rows, sha256: sha256(content) });
  };
  const csv = (name: string, rows: Array<Record<string, unknown>>, ids = {}) =>
    write(name, toCsv(expandColumns(exportFile(name), ids), rows), rows.length);

  /* players.csv */
  const lastConsent = new Map<number, PayloadOf<"ConsentRecorded">>();
  for (const e of events) if (e.type === "ConsentRecorded" && e.seat) lastConsent.set(e.seat, e.payload);
  const players = Object.values(final.seats)
    .filter((s) => s.bound || s.withdrawn)
    .map((s) => ({
      session_id: sessionId,
      seat: s.seat,
      participant_code: pid(s.participantCode),
      terminal: s.terminal,
      k_label: s.k,
      p_label: s.p,
      view: s.view,
      consent_status: s.consent,
      consent_version: lastConsent.get(s.seat)?.formVersion ?? null,
      demographics_submitted: s.demographics,
      briefing_acknowledged: s.briefing,
      withdrawn: s.withdrawn,
      reconnects: s.reconnects,
      rejections: s.rejections,
      pairing: final.labelPairing ? pairingName(final.labelPairing) : null,
      agent_policy: s.agent?.policy ?? null,
      fake_player: s.fake,
    }));
  csv("players.csv", players);

  /* actions.csv — walk the log so labels are taken as they were at action time */
  const acks = new Map<number, StoredTelemetry[]>();
  for (const t of telemetry) {
    if (t.type !== "state_received") continue;
    const list = acks.get(t.seat) ?? [];
    list.push(t);
    acks.set(t.seat, list);
  }
  for (const list of acks.values()) list.sort((a, b) => a.clientTs - b.clientTs);
  const lastAckBefore = (seat: number, ts: number): number | null => {
    const list = acks.get(seat);
    if (!list) return null;
    let lo = 0;
    let hi = list.length - 1;
    let found: number | null = null;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (list[mid]!.clientTs <= ts) {
        found = list[mid]!.clientTs;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return found;
  };
  const revokedBy = new Map<number, number>();
  for (const e of events) if (e.type === "ActionRevoked") revokedBy.set(e.payload.targetSeq, e.seq);
  const actions: Array<Record<string, unknown>> = [];
  const prevOwn = new Map<string, number>();
  const walk = initialState();
  for (const e of events) {
    let actionRow: Record<string, unknown> | null = null;
    if ((e.type === "ProposalMade" || e.type === "DecisionMade") && e.seat !== null) {
      const s = walk.seats[e.seat];
      const key = `${e.seat}:${e.round}`;
      const prev = prevOwn.get(key);
      const ack = lastAckBefore(e.seat, e.serverTs);
      actionRow = {
        session_id: sessionId,
        seq: e.seq,
        round: e.round,
        seat: e.seat,
        participant_code: pid(e.participantCode),
        k_label: s?.k ?? null,
        p_label: s?.p ?? null,
        view: s?.view ?? null,
        kind: e.type === "ProposalMade" ? "propose" : "decide",
        region_id: e.payload.regionId,
        region_name: regionNames.get(e.payload.regionId) ?? e.payload.regionId,
        square_id: parseCellId(e.payload.regionId)?.id ?? null,
        target_k: parseCellId(e.payload.regionId)?.k ?? null,
        server_ts: e.serverTs,
        server_wall: e.serverWall,
        client_ts: e.clientTs,
        client_seq: e.clientSeq,
        ms_since_round_start: e.payload.msSinceRoundStart,
        ms_since_prev_own_action: prev === undefined ? null : Math.round(e.serverTs - prev),
        reaction_ms: ack === null ? null : Math.round(e.serverTs - ack),
        quota_used: e.payload.quotaUsed,
        quota_limit: e.payload.quotaLimit,
        prior_proposals: e.payload.priorProposals,
        prior_decisions: e.payload.priorDecisions,
        score_changes: (e.payload.scoreChanges ?? [])
          .map((c) => `${c.regionId} ${c.from}>${c.to}`)
          .join("; "),
        map_score_after: null,
        revoked: revokedBy.has(e.seq),
        revoked_by_seq: revokedBy.get(e.seq) ?? null,
      };
      actions.push(actionRow);
      prevOwn.set(key, e.serverTs);
    }
    applyEvent(walk, e);
    if (actionRow && walk.board) {
      const score = mapScoreOf(walk);
      actionRow.map_score_after = score === null ? null : Math.round(score * 10_000) / 10_000;
    }
  }
  csv("actions.csv", actions);

  /* events.csv */
  csv(
    "events.csv",
    events.map((e) => ({
      session_id: sessionId,
      seq: e.seq,
      type: e.type,
      actor_kind: e.actorKind,
      seat: e.seat,
      participant_code: pid(e.participantCode),
      round: e.round,
      server_ts: e.serverTs,
      server_wall: e.serverWall,
      client_ts: e.clientTs,
      client_seq: e.clientSeq,
      payload_json: e.type === "DemographicsSubmitted" ? { redacted: true } : e.payload,
    })),
  );

  /* telemetry.csv */
  csv(
    "telemetry.csv",
    telemetry.map((t) => ({
      id: t.id,
      session_id: sessionId,
      seat: t.seat,
      participant_code: pid(t.participantCode),
      round: t.round,
      type: t.type,
      client_ts: t.clientTs,
      client_offset_ms: t.clientOffsetMs,
      server_ts: t.serverTs,
      server_wall: t.serverWall,
      payload_json: t.payload,
    })),
  );

  /* consent.csv / demographics.csv — dynamic columns from the answers actually given */
  const consentEvents = events.filter(
    (e): e is Extract<StoredEvent, { type: "ConsentRecorded" }> => e.type === "ConsentRecorded",
  );
  const consentItems = unique(consentEvents.flatMap((e) => Object.keys(e.payload.answers)));
  csv(
    "consent.csv",
    consentEvents.map((e) => ({
      session_id: sessionId,
      seq: e.seq,
      seat: e.seat,
      participant_code: pid(e.participantCode),
      form_version: e.payload.formVersion,
      text_sha256: e.payload.textSha256,
      consented: e.payload.consented,
      duration_ms: e.payload.durationMs,
      server_wall: e.serverWall,
      ...Object.fromEntries(consentItems.map((id) => [`answer_${id}`, e.payload.answers[id] ?? null])),
    })),
    { consentItems },
  );
  const demoEvents = events.filter(
    (e): e is Extract<StoredEvent, { type: "DemographicsSubmitted" }> => e.type === "DemographicsSubmitted",
  );
  const demographicQuestions = unique(demoEvents.flatMap((e) => Object.keys(e.payload.answers)));
  csv(
    "demographics.csv",
    demoEvents.map((e) => ({
      session_id: sessionId,
      seat: e.seat,
      participant_code: pid(e.participantCode),
      form_version: e.payload.formVersion,
      duration_ms: e.payload.durationMs,
      server_wall: e.serverWall,
      ...Object.fromEntries(demographicQuestions.map((id) => [`q_${id}`, e.payload.answers[id] ?? null])),
    })),
    { demographicQuestions },
  );

  /* audio_tracks.csv — the index only: no keys, no file names, no audio */
  const flag = (v: unknown) => (typeof v === "boolean" ? v : null);
  const int = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  csv(
    "audio_tracks.csv",
    tracks.map(({ row: t, summary }) => ({
      session_id: sessionId,
      seat: t.seat,
      participant_code: pid(t.participantCode),
      track_id: t.trackId,
      status: summary.status,
      start_reason: t.reason,
      stop_reason: t.stopReason,
      started_server_ts: t.startedServerTs,
      first_sample_ts: t.startedClientTs,
      closed_server_ts: t.closedServerTs,
      duration_ms: t.durationMs,
      samples: t.samples,
      chunks: t.chunks,
      dropped_chunks: t.droppedChunks,
      gaps: summary.gaps,
      sample_rate: t.sampleRate,
      capture_sample_rate: int(t.settings.sampleRate),
      echo_cancellation: flag(t.settings.echoCancellation),
      noise_suppression: flag(t.settings.noiseSuppression),
      auto_gain_control: flag(t.settings.autoGainControl),
      channel_count: int(t.settings.channelCount),
    })),
  );

  /* speech_segments.csv — who spoke when (timing only, never voice content) */
  csv(
    "speech_segments.csv",
    speech.map((g) => ({
      session_id: sessionId,
      seat: g.seat,
      participant_code: pid(g.participantCode),
      start_server_ts: g.startTs,
      end_server_ts: g.endTs,
      duration_ms: g.durationMs,
      round: g.round,
      phase: g.phase,
      paused: g.paused,
      recording_paused: g.recordingPaused,
      mean_db: g.meanDb,
      confidence: g.confidence,
      overlap: g.overlap,
      overlap_ms: g.overlapMs,
      overlap_with: g.overlapWith,
      engine_version: g.engineVersion,
    })),
  );

  /* session.json */
  const created = events.find(
    (e): e is Extract<StoredEvent, { type: "SessionCreated" }> => e.type === "SessionCreated",
  );
  const session = {
    exportId: id,
    kind,
    exportedWall: wall(now),
    sessionId,
    status: final.phase,
    createdWall: row.created_wall,
    scenario: created?.payload.scenario ?? null,
    config: parseSessionConfig(created?.payload.config ?? JSON.parse(row.config_json)),
    tags: JSON.parse(row.tags_json ?? "[]") as string[],
    notes: row.notes,
    harness: created?.payload.harness ?? { version: row.harness_version, gitCommit: row.git_commit },
    rounds: final.rounds.map((r) => {
      const done = events.find(
        (e): e is Extract<StoredEvent, { type: "RoundCompleted" }> =>
          e.type === "RoundCompleted" && e.payload.round === r.round,
      );
      return {
        round: r.round,
        startedWall: wall(r.startedTs),
        endedWall: r.endedTs === null ? null : wall(r.endedTs),
        reason: r.reason,
        durationMs: done?.payload.durationMs ?? null,
        pausedMs: done?.payload.pausedMs ?? null,
      };
    }),
    labelPairing: final.labelPairing
      ? {
          ...final.labelPairing,
          name: pairingName(final.labelPairing),
          pairs: pairingText(final.labelPairing),
        }
      : null,
    fakeSeats: fakeSeats(final),
    counts: {
      events: events.length,
      telemetry: telemetry.length,
      actions: actions.length,
      players: players.length,
      audioTracks: tracks.length,
      speechSegments: speech.length,
    },
  };
  write("session.json", `${JSON.stringify(session, null, 2)}\n`, 1);

  /* codebook.md */
  write(
    "codebook.md",
    renderCodebook({
      sessionId,
      exportId: id,
      kind,
      createdWall: wall(now),
      harness: session.harness,
      scenario: created?.payload.scenario,
      consentItems,
      demographicQuestions,
    }),
    1,
  );

  /* manifest.json (+ register in the DB) */
  const codeHashes = [...codes].map((c) => sha256(c)).sort();
  const manifest = {
    exportId: id,
    sessionId,
    kind,
    createdWall: wall(now),
    files: written,
    codeHashes: kind === "anonymised" ? [] : codeHashes,
  };
  writeFileSync(path.join(dir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  registerExport(store, {
    id,
    sessionId,
    kind,
    createdWall: wall(now),
    path: dir,
    codeHashes,
    files: written,
  });

  // sanity: every defined file exists
  const present = new Set(readdirSync(dir));
  for (const f of EXPORT_FILES) if (!present.has(f.file)) throw new Error(`export is missing ${f.file}`);

  return { exportId: id, kind, sessionId, dir, files: written, participants: codes.size };
}

/**
 * Add an entry to the export register (`exports`). `codeHashes` are the SHA-256
 * of every participant code the export contains, so an erasure request finds it.
 */
export function registerExport(
  store: Store,
  e: {
    id: string;
    sessionId: string;
    kind: RegisteredExportKind;
    createdWall: string;
    path: string;
    codeHashes: string[];
    files: unknown[];
    details?: Record<string, unknown>;
  },
) {
  store.db
    .prepare(
      `INSERT INTO exports (id, session_id, kind, created_wall, path, code_hashes_json, files_json, details_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      e.id,
      e.sessionId,
      e.kind,
      e.createdWall,
      e.path,
      JSON.stringify([...e.codeHashes].sort()),
      JSON.stringify(e.files),
      JSON.stringify(e.details ?? {}),
    );
}

function unique(xs: string[]): string[] {
  return [...new Set(xs)];
}

export interface ExportRow {
  id: string;
  sessionId: string;
  kind: RegisteredExportKind;
  createdWall: string;
  path: string;
}

export function listExports(store: Store): ExportRow[] {
  const rows = store.db.prepare("SELECT * FROM exports ORDER BY created_wall DESC").all() as Array<{
    id: string;
    session_id: string;
    kind: RegisteredExportKind;
    created_wall: string;
    path: string;
  }>;
  return rows.map((r) => ({
    id: r.id,
    sessionId: r.session_id,
    kind: r.kind,
    createdWall: r.created_wall,
    path: r.path,
  }));
}

/** Exports whose register entry contains this participant code (by hash). */
export function exportsContaining(store: Store, code: string): ExportRow[] {
  const h = sha256(code);
  const rows = store.db.prepare("SELECT * FROM exports ORDER BY created_wall").all() as Array<{
    id: string;
    session_id: string;
    kind: RegisteredExportKind;
    created_wall: string;
    path: string;
    code_hashes_json: string;
  }>;
  return rows
    .filter((r) => (JSON.parse(r.code_hashes_json) as string[]).includes(h))
    .map((r) => ({
      id: r.id,
      sessionId: r.session_id,
      kind: r.kind,
      createdWall: r.created_wall,
      path: r.path,
    }));
}

/** Read back a manifest (used by tests and the CLI). */
export function readManifest(dir: string) {
  return JSON.parse(readFileSync(path.join(dir, "manifest.json"), "utf8"));
}
