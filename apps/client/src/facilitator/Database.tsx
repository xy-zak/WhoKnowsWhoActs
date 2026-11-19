import {
  type AudioFilesRemoved,
  type ErasureRows,
  isSimulatedSessionId,
  normaliseParticipantCode,
  type PlayerMode,
  type SessionDeletionResult,
} from "@wkwa/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { fmtDuration, fmtMinutes, plural } from "../common/format";
import { useLatest } from "../net/latest";
import {
  Button,
  Callout,
  Check,
  Chip,
  Field,
  Icon,
  Panel,
  Popup,
  SeatDot,
  StatusTag,
  useConfirm,
} from "../ui";
import type { FacilitatorConnection } from "./connection";
import { AudioPopup } from "./database/AudioPopup";
import { type AudioSessionView, audioCell, whenWall as when } from "./database/audioModel";

interface SessionSummary {
  id: string;
  /** Which database the session is in. */
  players: PlayerMode;
  createdWall: string;
  updatedWall: string;
  scenarioId: string;
  scenarioVersion: string;
  status: string;
  tags: string[];
  notes: string;
  eventCount: number;
  telemetryCount: number;
  /** Seats played by fake players (test clients the server created). */
  fakeSeats: number[];
  /** Tracks whose audio is still stored (raw-deleted tracks not counted), and their recorded duration (ms). */
  audioTracks?: number;
  audioMs?: number;
}
interface ExportResult {
  /** Database of the exported session (set here, from the session row). */
  players: PlayerMode;
  exportId: string;
  kind: string;
  dir: string;
  files: Array<{ name: string; rows: number }>;
}
interface ExportRow {
  id: string;
  sessionId: string;
  kind: string;
  createdWall: string;
  path: string;
}
interface Lookup {
  code: string;
  occurrences: Array<{
    sessionId: string;
    seat: number | null;
    events: number;
    telemetry: number;
    audioTracks?: number;
    audioMs?: number;
  }>;
  exports: ExportRow[];
  previouslyErased: Array<{ executedWall: string }>;
}
interface Deletion {
  id: number;
  sessionId: string;
  deletedWall: string;
  rows: { events: number; telemetry: number; audioTracks?: number };
  participants: number;
}
interface Erasure {
  id: number;
  codeSha256: string;
  executedWall: string;
  sessions: Array<{ sessionId: string }>;
  rows: { events: number; telemetry: number; audioTracks?: number; audioFiles?: number };
  note: string;
}
/** Rows and audio files removed by an erasure. */
interface ErasureAudio {
  rows: ErasureRows;
  audioFiles: AudioFilesRemoved;
}
type SessionDeleteResult = SessionDeletionResult;

const STATUS_TONE: Record<string, "live" | "warn" | "danger" | "neutral" | "primary"> = {
  lobby: "primary",
  onboarding: "live",
  round_active: "live",
  round_complete: "live",
  game_complete: "warn",
  closed: "neutral",
  aborted: "danger",
};

/** Register rows of both databases, each tagged with its database by the server. */
type InDb<T> = T & { players: PlayerMode };

const DATABASES: Array<{ id: PlayerMode; icon: "seats" | "simulation"; label: string; file: string }> = [
  { id: "real", icon: "seats", label: "Participants", file: "data/wkwa.db" },
  { id: "simulated", icon: "simulation", label: "Simulations", file: "data/wkwa-sim.db" },
];

/**
 * DATABASE tab, in order of use: 1 sessions (resume · replay · export · print)
 * → 2 exports register → 3 takedown / erasure → 4 erasure register → 5 session deletions.
 * A switch at the top picks the participant or the simulation database;
 * takedown and erasure only exist for participants.
 */
export function Database({
  conn,
  attachedId,
  onReplay,
  onResumed,
}: {
  conn: FacilitatorConnection;
  attachedId: string | null;
  onReplay: (id: string) => void;
  onResumed: () => void;
}) {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [exports, setExports] = useState<InDb<ExportRow>[]>([]);
  const [erasures, setErasures] = useState<Erasure[]>([]);
  const [lastExport, setLastExport] = useState<ExportResult | null>(null);
  const [filter, setFilter] = useState("");
  const [cardsFor, setCardsFor] = useState<string | null>(null);
  const [audioFor, setAudioFor] = useState<string | null>(null);
  const [deletions, setDeletions] = useState<InDb<Deletion>[]>([]);
  const [db, setDb] = useState<PlayerMode>(() =>
    attachedId && isSimulatedSessionId(attachedId) ? "simulated" : "real",
  );
  const simulated = db === "simulated";
  const confirm = useConfirm();
  const latest = useLatest();
  const refresh = useCallback(() => {
    const ifLatest = latest();
    conn.api<SessionSummary[]>("/api/sessions").then(ifLatest(setSessions), () => {});
    conn.api<InDb<ExportRow>[]>("/api/exports").then(ifLatest(setExports), () => {});
    conn.api<Erasure[]>("/api/erasures").then(ifLatest(setErasures), () => {});
    conn.api<InDb<Deletion>[]>("/api/session-deletions").then(ifLatest(setDeletions), () => {});
  }, [conn, latest]);
  useEffect(refresh, [refresh]);

  const doExport = async (s: SessionSummary, kind: "export" | "anonymise") => {
    const r = await conn
      .api<Omit<ExportResult, "players">>(`/api/sessions/${s.id}/${kind}`, { method: "POST" })
      .catch(() => null);
    if (r) {
      setLastExport({ ...r, players: s.players });
      conn.toast(`${r.kind} export written`);
      refresh();
    }
  };

  /** True while the audio counts for a delete confirmation load (a second click does nothing). */
  const countingAudio = useRef(false);
  const removeSession = async (s: SessionSummary) => {
    if (countingAudio.current) return;
    const deleteExports = { current: false };
    countingAudio.current = true;
    const audio = await (s.players === "real" ? sessionAudioCounts(conn, s) : null);
    countingAudio.current = false;
    const ok = await confirm({
      title: `Delete session ${s.id}`,
      icon: "erase",
      danger: true,
      requireText: s.id,
      confirmLabel: "Delete permanently",
      message: (
        <div className="col">
          <p>
            Deletes <strong>everything</strong> of this session from the database: {s.eventCount} events and{" "}
            {s.telemetryCount} telemetry rows, including the participants' consent and demographics
            {audio && audio.tracks > 0 && (
              <>
                , and its audio: {plural(audio.tracks, "track")} ({fmtMinutes(audio.ms)} recorded) and{" "}
                {plural(audio.files, "encrypted audio file")} with their keys
                {audio.files === 0 && " (the raw audio was already deleted: metadata only)"}
              </>
            )}
            . This cannot be undone.
          </p>
          {audio && audio.tracks > 0 && (
            <p className="muted">
              Audio exports already written are export folders: they are deleted only with the option below.
            </p>
          )}
          <p className="muted">
            A register entry (session id, row counts, hashes of the codes) is kept so the deletion can be
            re-applied after restoring an older backup. Backups made before now still contain the session.
          </p>
          <DeleteExportsCheck onChange={(v) => (deleteExports.current = v)} />
        </div>
      ),
    });
    if (!ok) return;
    const r = await conn
      .api<SessionDeleteResult>(`/api/sessions/${s.id}/delete`, {
        method: "POST",
        body: JSON.stringify({ confirm: s.id, deleteExports: deleteExports.current }),
      })
      .catch(() => null);
    if (!r) return;
    const audioText = r.rows.audioTracks
      ? `, ${plural(r.rows.audioTracks, "audio track")}, ${plural(r.audio?.files ?? 0, "audio file")} removed`
      : "";
    const audioError = r.audio?.error ? ` — audio folder not removed: ${r.audio.error}` : "";
    const exportsLeft =
      r.exportPaths.length && !r.exportsDeleted
        ? ` — export folders still on disk: ${r.exportPaths.join(", ")}`
        : "";
    conn.toast(
      `Session ${s.id} deleted (${r.rows.events} events, ${r.rows.telemetry} telemetry rows${audioText})${audioError}${exportsLeft}`,
      audioError || exportsLeft ? "warn" : "ok",
    );
    refresh();
  };

  const ofDb = <T extends { players: PlayerMode }>(rows: T[], d: PlayerMode = db) =>
    rows.filter((x) => x.players === d);
  const inDb = ofDb(sessions);
  const shown = inDb.filter(
    (s) =>
      !filter ||
      s.id.toLowerCase().includes(filter.toLowerCase()) ||
      s.tags.some((t) => t.toLowerCase().includes(filter.toLowerCase())),
  );
  const exportsShown = ofDb(exports);
  const deletionsShown = ofDb(deletions);
  const lastExportShown = lastExport?.players === db ? lastExport : null;

  return (
    <div className="col" style={{ gap: "var(--s3)" }}>
      <div className="row">
        <nav className="tabs subtabs" aria-label="Database">
          {DATABASES.map((d) => (
            <button
              key={d.id}
              type="button"
              className={`tab${db === d.id ? " active" : ""}`}
              aria-pressed={db === d.id}
              onClick={() => setDb(d.id)}
              data-tip={
                d.id === "real"
                  ? "Sessions with real participants: personal data, takedown and erasure apply"
                  : "Sessions played by simulated players only (no participants)"
              }
            >
              <Icon name={d.icon} />
              {d.label} · {ofDb(sessions, d.id).length}
              <span className="faint">{d.file}</span>
            </button>
          ))}
        </nav>
        <span className="hint">
          {simulated
            ? "Simulated sessions: agents only, no personal data. Exports go to exports/simulations/."
            : "Sessions with real participants (pseudonymised personal data)."}
        </span>
      </div>
      <Panel
        title={`1 · ${simulated ? "Simulated sessions" : "Sessions"} · ${inDb.length}`}
        icon="database"
        actions={
          <Button size="sm" icon="refresh" tip="Reload the session list and registers" onClick={refresh}>
            Refresh
          </Button>
        }
      >
        <div className="col">
          <div className="row">
            <input
              type="text"
              aria-label="Filter sessions"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter by id or tag…"
            />
          </div>
          <div style={{ overflowX: "auto" }}>
            <table className="grid">
              <thead>
                <tr>
                  <th>Session</th>
                  <th>Created</th>
                  <th>Status</th>
                  <th>Scenario</th>
                  <th>Tags</th>
                  <th>Events</th>
                  <th>Telemetry</th>
                  <th>Audio</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {shown.map((s) => (
                  <tr key={s.id} className={s.id === attachedId ? "selected" : ""}>
                    <td className="mono">
                      {s.id} {s.id === attachedId && <StatusTag tone="live">attached</StatusTag>}
                    </td>
                    <td className="small">{when(s.createdWall)}</td>
                    <td>
                      <StatusTag tone={STATUS_TONE[s.status] ?? "neutral"}>
                        {s.status.replace("_", " ")}
                      </StatusTag>
                    </td>
                    <td className="small">
                      {s.scenarioId} v{s.scenarioVersion}
                    </td>
                    <td>
                      <span className="row" style={{ gap: 4 }}>
                        {s.fakeSeats.length > 0 && (
                          <StatusTag
                            icon="fake"
                            title={`Seat ${s.fakeSeats.join(", ")} played by fake players (test clients, not participants)`}
                          >
                            fake ×{s.fakeSeats.length}
                          </StatusTag>
                        )}
                        {s.tags.map((t) => (
                          <Chip key={t}>{t}</Chip>
                        ))}
                      </span>
                    </td>
                    <td>{s.eventCount}</td>
                    <td>{s.telemetryCount}</td>
                    <td className="mono small">
                      {s.players === "simulated" ? (
                        <span className="faint" data-tip="Simulated sessions never record audio">
                          —
                        </span>
                      ) : (
                        <Button
                          size="sm"
                          variant="ghost"
                          icon="voice"
                          tip={
                            s.audioTracks
                              ? `${plural(s.audioTracks, "audio track")}, ${fmtDuration(s.audioMs)} recorded. Open the audio of this session: seats, speaker attribution, export audio, delete audio.`
                              : "No stored audio. Open to see the audio metadata and deletion register of this session."
                          }
                          onClick={() => setAudioFor(s.id)}
                        >
                          {audioCell(s.audioTracks, s.audioMs)}
                        </Button>
                      )}
                    </td>
                    <td>
                      <div className="row" style={{ gap: 4, justifyContent: "flex-end" }}>
                        {s.id !== attachedId && !["closed", "aborted"].includes(s.status) && (
                          <Button
                            size="sm"
                            icon="resumeSession"
                            tip="Attach this unfinished session again (e.g. after a server restart). Players re-join their seats automatically."
                            onClick={() =>
                              conn
                                .cmd("session:resume", { sessionId: s.id }, "Session resumed")
                                .then(onResumed, () => {})
                            }
                          >
                            Resume
                          </Button>
                        )}
                        <Button
                          size="sm"
                          icon="replay"
                          tip="Watch the session again in REPLAY: 1 s per action, pausing at each round end."
                          onClick={() => onReplay(s.id)}
                        >
                          Replay
                        </Button>
                        <Button
                          size="sm"
                          icon="export"
                          tip={
                            simulated
                              ? "Write an export (CSV + JSON + codebook) of this simulation to exports/simulations/. No personal data."
                              : "Write a pseudonymised export (CSV + JSON + codebook) with participant codes, for analysis. Store it on institutional storage."
                          }
                          onClick={() => void doExport(s, "export")}
                        >
                          Export
                        </Button>
                        {!simulated && (
                          <>
                            <Button
                              size="sm"
                              icon="anonymise"
                              tip="Write an anonymised export: participant codes replaced by random ids, mapping discarded. For publishing or archiving."
                              onClick={() => void doExport(s, "anonymise")}
                            >
                              Anonymised
                            </Button>
                            <Button
                              size="sm"
                              icon="keysheet"
                              tip="Open the printable key sheet (seat → code, names written by hand). Print it; don't save it."
                              onClick={() =>
                                void conn
                                  .openPrintable(`/api/sessions/${s.id}/print/keysheet`)
                                  .catch(() => {})
                              }
                            >
                              Key sheet
                            </Button>
                            <Button
                              size="sm"
                              icon="cards"
                              tip="Download each participant's takedown card as its own PDF (one per seat)."
                              onClick={() => setCardsFor(s.id)}
                            >
                              Cards
                            </Button>
                          </>
                        )}
                        <Button
                          size="sm"
                          variant="danger"
                          icon="erase"
                          tip="Permanently delete the whole session from the database (asks for confirmation)."
                          disabled={
                            s.id === attachedId && !["closed", "aborted", "game_complete"].includes(s.status)
                          }
                          onClick={() => void removeSession(s)}
                        >
                          Delete
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
                {shown.length === 0 && (
                  <tr>
                    <td colSpan={9} className="faint">
                      {inDb.length
                        ? "No session matches the filter."
                        : simulated
                          ? "No simulations yet — choose 'Simulated players' in SETUP step 03."
                          : "No sessions yet — create one in SETUP."}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          {lastExportShown && (
            <Callout
              tone={lastExportShown.kind === "standard" && !simulated ? "warn" : "live"}
              icon={lastExportShown.kind === "standard" ? "export" : "anonymise"}
            >
              <strong>
                {simulated ? "simulation" : lastExportShown.kind} export {lastExportShown.exportId}
              </strong>{" "}
              → <code>{lastExportShown.dir}</code>
              <br />
              {lastExportShown.files.map((f) => `${f.name} (${f.rows})`).join(" · ")}
              {lastExportShown.kind === "standard" && !simulated && (
                <>
                  <br />
                  Contains pseudonymised personal data: move it to institutional storage and delete the local
                  copy.
                </>
              )}
            </Callout>
          )}
        </div>
      </Panel>

      <div className="grid-2" style={{ alignItems: "start" }}>
        {simulated ? (
          <Panel title="Takedown / erasure" icon="erase">
            <Callout icon="simulation">
              The simulation database holds no participants, so there is nothing to look up or erase. Delete a
              whole simulation from the session list instead.
            </Callout>
          </Panel>
        ) : (
          <ErasurePanel conn={conn} onDone={refresh} />
        )}
        <div className="col">
          <Panel title={`2 · Exports · ${exportsShown.length}`} icon="register">
            <div style={{ maxHeight: 260, overflow: "auto" }}>
              <table className="grid">
                <tbody>
                  {exportsShown.map((x) => (
                    <tr key={x.id}>
                      <td className="mono small">{x.id}</td>
                      <td>
                        <StatusTag
                          tone={x.kind === "anonymised" || x.players === "simulated" ? "live" : "warn"}
                          icon={x.kind === "anonymised" ? "anonymise" : "export"}
                        >
                          {x.players === "simulated" ? "simulation" : x.kind}
                        </StatusTag>
                      </td>
                      <td className="mono small">{x.sessionId}</td>
                      <td className="small">{when(x.createdWall)}</td>
                    </tr>
                  ))}
                  {exportsShown.length === 0 && (
                    <tr>
                      <td className="faint">No exports yet.</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </Panel>
          <Panel
            title={`${simulated ? 3 : 5} · Session deletions · ${deletionsShown.length}`}
            icon="register"
          >
            <div className="col">
              <span className="hint">
                Deleted sessions, kept to re-apply a deletion after restoring an older backup.
              </span>
              <table className="grid">
                <tbody>
                  {deletionsShown.map((d) => (
                    <tr key={d.id}>
                      <td className="mono small">{d.sessionId}</td>
                      <td className="small">{when(d.deletedWall)}</td>
                      <td className="small">
                        {d.participants} participants · {d.rows.events} ev · {d.rows.telemetry} tel
                        {d.rows.audioTracks ? ` · ${d.rows.audioTracks} audio tr` : ""}
                      </td>
                    </tr>
                  ))}
                  {deletionsShown.length === 0 && (
                    <tr>
                      <td className="faint">None.</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </Panel>
          {!simulated && (
            <Panel title={`4 · Erasure register · ${erasures.length}`} icon="register">
              <div className="col">
                <span className="hint">
                  Only SHA-256 hashes of erased codes, to re-apply erasures after restoring a backup.
                </span>
                <table className="grid">
                  <thead>
                    <tr>
                      <th>#</th>
                      <th>Executed</th>
                      <th>Code hash</th>
                      <th>Rows</th>
                      <th>Note</th>
                    </tr>
                  </thead>
                  <tbody>
                    {erasures.map((e) => (
                      <tr key={e.id}>
                        <td>{e.id}</td>
                        <td className="small">{when(e.executedWall)}</td>
                        <td className="mono small">{e.codeSha256.slice(0, 12)}…</td>
                        <td className="small">
                          {e.rows.events} ev · {e.rows.telemetry} tel
                          {e.rows.audioTracks ? ` · ${e.rows.audioTracks} audio tr` : ""}
                        </td>
                        <td className="small">{e.note}</td>
                      </tr>
                    ))}
                    {erasures.length === 0 && (
                      <tr>
                        <td colSpan={5} className="faint">
                          Empty.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </Panel>
          )}
        </div>
      </div>
      {cardsFor && <CardsPopup conn={conn} sessionId={cardsFor} onClose={() => setCardsFor(null)} />}
      {audioFor && (
        <AudioPopup conn={conn} sessionId={audioFor} onClose={() => setAudioFor(null)} onChanged={refresh} />
      )}
    </div>
  );
}

/**
 * Audio of a session for the delete confirmation: every track row (also raw-deleted ones), their
 * recorded time, and the encrypted files still stored (raw tracks + cleaned tracks). Falls back to
 * the session row's counts when the audio summary cannot be read.
 */
async function sessionAudioCounts(
  conn: FacilitatorConnection,
  s: SessionSummary,
): Promise<{ tracks: number; ms: number; files: number }> {
  const fallback = { tracks: s.audioTracks ?? 0, ms: s.audioMs ?? 0, files: s.audioTracks ?? 0 };
  const v = await conn.api<AudioSessionView>(`/api/sessions/${s.id}/audio`).catch(() => null);
  if (!v) return fallback;
  const stored = v.tracks.filter((t) => t.status !== "deleted");
  // recorded time of every track (a raw-deleted track keeps its length); files = what is still stored
  return {
    tracks: v.tracks.length,
    ms: v.tracks.reduce((n, t) => n + t.durationMs, 0),
    files: stored.length + v.derivatives.length,
  };
}

function DeleteExportsCheck({ onChange }: { onChange: (v: boolean) => void }) {
  const [v, setV] = useState(false);
  return (
    <Check
      label="Also delete this session's export folders on this computer"
      hint="Copies elsewhere (research drive, USB) must be deleted by hand."
      checked={v}
      onChange={(x) => {
        setV(x);
        onChange(x);
      }}
    />
  );
}

/** One takedown card PDF per seat (participant), downloaded individually. */
function CardsPopup({
  conn,
  sessionId,
  onClose,
}: {
  conn: FacilitatorConnection;
  sessionId: string;
  onClose: () => void;
}) {
  const [seats, setSeats] = useState<number[] | null>(null);
  const latest = useLatest();
  useEffect(() => {
    const ifLatest = latest();
    conn.api<{ seats: number[] }>(`/api/sessions/${sessionId}/cards`).then(
      ifLatest((r) => setSeats(r.seats)),
      ifLatest(() => setSeats([])),
    );
  }, [conn, sessionId, latest]);
  return (
    <Popup
      title="Takedown cards"
      icon="cards"
      width={560}
      onClose={onClose}
      footer={
        <>
          <span className="spacer" />
          <Button icon="close" kbd="Esc" onClick={onClose}>
            Done
          </Button>
        </>
      }
    >
      <p className="small muted">
        One A6 PDF per participant ({sessionId}). Print each and hand it to the participant of that seat. The
        PDFs contain the participant code: delete the downloaded files after printing.
      </p>
      {seats === null && <span className="muted cursor">Loading</span>}
      {seats?.length === 0 && <span className="faint">No seat has a participant code in this session.</span>}
      <div className="col">
        {seats?.map((seat) => (
          <div key={seat} className="row">
            <SeatDot seat={seat} />
            <strong>SEAT {seat}</strong>
            <span className="spacer" />
            <Button
              size="sm"
              icon="export"
              tip={`Download takedown-card-${sessionId}-seat${seat}.pdf`}
              onClick={() =>
                void conn
                  .download(
                    `/api/sessions/${sessionId}/cards/${seat}`,
                    `takedown-card-${sessionId}-seat${seat}.pdf`,
                  )
                  .catch(() => {})
              }
            >
              Card PDF
            </Button>
          </div>
        ))}
      </div>
    </Popup>
  );
}

function ErasurePanel({ conn, onDone }: { conn: FacilitatorConnection; onDone: () => void }) {
  const confirm = useConfirm();
  const [input, setInput] = useState("");
  const [look, setLook] = useState<Lookup | null>(null);
  const [note, setNote] = useState("");
  const [result, setResult] = useState<{ text: string; audio: string | null; failed: string[] } | null>(null);
  const code = normaliseParticipantCode(input);
  const audioTracks = look?.occurrences.reduce((n, o) => n + (o.audioTracks ?? 0), 0) ?? 0;
  const audioMs = look?.occurrences.reduce((n, o) => n + (o.audioMs ?? 0), 0) ?? 0;
  const audioSessions =
    look?.occurrences.filter((o) => (o.audioTracks ?? 0) > 0).map((o) => o.sessionId) ?? [];

  const lookup = async () => {
    setResult(null);
    setLook(await conn.api<Lookup>(`/api/participants/${encodeURIComponent(input)}`).catch(() => null));
  };
  const erase = async () => {
    if (!look) return;
    const ok = await confirm({
      title: "Erase participant data",
      icon: "erase",
      danger: true,
      requireText: look.code,
      confirmLabel: "Erase permanently",
      message: (
        <div className="col">
          <p>
            Deletes <strong>every event and telemetry row</strong> of{" "}
            <span className="mono">{look.code}</span> in {look.occurrences.length} session(s)
            {audioTracks > 0 && (
              <>
                , and their audio: {plural(audioTracks, "track")} ({fmtDuration(audioMs)}) with their
                encrypted files and keys where still stored
              </>
            )}
            . This cannot be undone.
          </p>
          {audioTracks > 0 && (
            <p className="muted">
              Every result made from this participant's audio in{" "}
              {audioSessions.length === 1 ? "that session" : "those sessions"} goes too: the speaker
              attribution (speech segments, talk time, quality report) and the cleaned tracks of every seat.
              Run the speaker attribution again there if the raw audio is still stored. The other
              participants' raw audio stays.
            </p>
          )}
          {look.exports.length > 0 && (
            <p className="t-warn">
              {look.exports.length} export(s) contain this participant and must be deleted and regenerated.
            </p>
          )}
        </div>
      ),
    });
    if (!ok) return;
    const r = await conn
      .api<ErasureAudio & { exports: ExportRow[] }>(`/api/participants/${look.code}/erase`, {
        method: "POST",
        body: JSON.stringify({ confirm: look.code, note }),
      })
      .catch(() => null);
    if (!r) return;
    const audioRows = (r.rows.audioTracks ?? 0) + (r.rows.audioDerivatives ?? 0);
    setResult({
      text:
        `Erased ${r.rows.events} events and ${r.rows.telemetry} telemetry rows.` +
        (r.exports.length
          ? ` Delete and regenerate on every copy: ${r.exports.map((e) => e.path).join(", ")}.`
          : "") +
        " Cross out the line on the key sheet. Backups made earlier still contain the data.",
      audio:
        audioRows > 0
          ? `Audio: ${plural(r.rows.audioTracks ?? 0, "track")} (${plural(r.rows.audioChunks ?? 0, "chunk")}) and ${plural(r.rows.audioDerivatives ?? 0, "derived result")} deleted with their keys; ${plural(r.audioFiles?.removed ?? 0, "encrypted file")} removed. The attribution results and every seat's cleaned tracks of ${audioSessions.join(", ") || "the session"} were removed with them: run the speaker attribution again there (if its raw audio is still stored).`
          : null,
      failed: r.audioFiles?.failed ?? [],
    });
    setLook(null);
    setInput("");
    setNote("");
    onDone();
  };

  return (
    <Panel title="3 · Takedown / erasure" icon="erase">
      <div className="col">
        <span className="hint">
          Enter the code from the participant's request, or from the key sheet. Typos are caught by the check
          character.
        </span>
        <form
          className="row nowrap"
          onSubmit={(e) => {
            e.preventDefault();
            if (code) void lookup();
          }}
        >
          <input
            type="text"
            aria-label="Participant code"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="WK-XXXX-XXXX-X"
            style={{ flex: 1 }}
          />
          <Button
            type="submit"
            icon="search"
            disabled={!code}
            tip="Find every session and row that holds this participant code"
          >
            Look up
          </Button>
        </form>
        {input && !code && (
          <span className="small t-danger">
            <Icon name="error" /> Not a valid participant code.
          </span>
        )}
        {look && (
          <div className="col">
            <strong className="mono">{look.code}</strong>
            {look.occurrences.length === 0 ? (
              <span className="muted">
                No data stored for this code.
                {look.previouslyErased.length > 0 &&
                  ` Erased on ${look.previouslyErased.map((p) => p.executedWall.slice(0, 10)).join(", ")}.`}
              </span>
            ) : (
              <>
                <table className="grid">
                  <tbody>
                    {look.occurrences.map((o) => (
                      <tr key={o.sessionId}>
                        <td className="mono">{o.sessionId}</td>
                        <td>seat {o.seat}</td>
                        <td>{o.events} events</td>
                        <td>{o.telemetry} telemetry</td>
                        <td>
                          {o.audioTracks ? (
                            `${plural(o.audioTracks, "audio track")} (${fmtDuration(o.audioMs)})`
                          ) : (
                            <span className="faint">no audio</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {look.exports.length > 0 && (
                  <span className="small t-warn">
                    Contained in export(s): {look.exports.map((e) => e.id).join(", ")}
                  </span>
                )}
                <Field label="Note (optional)" hint="e.g. the request date — no names">
                  <input type="text" value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} />
                </Field>
                <div className="row">
                  <span className="spacer" />
                  <Button
                    variant="danger"
                    icon="erase"
                    tip="Erase all data of this participant (asks you to type the code again)"
                    onClick={() => void erase()}
                  >
                    Erase…
                  </Button>
                </div>
              </>
            )}
          </div>
        )}
        {result && (
          <Callout
            tone={result.failed.length ? "warn" : "live"}
            icon={result.failed.length ? "warning" : "ok"}
          >
            {result.text}
            {result.audio && (
              <>
                <br />
                {result.audio}
              </>
            )}
            {result.failed.length > 0 && (
              <>
                <br />
                <span className="t-danger">
                  <Icon name="error" /> Audio files that could not be removed (unreadable: their keys are
                  gone; delete them by hand): {result.failed.join(", ")}
                </span>
              </>
            )}
          </Callout>
        )}
      </div>
    </Panel>
  );
}
