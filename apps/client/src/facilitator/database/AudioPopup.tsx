import { memo, useCallback, useEffect, useId, useMemo, useReducer, useRef, useState } from "react";
import { fmtBytes, fmtDuration, fmtShare, fmtSigned, PLACEHOLDER } from "../../common/format";
import {
  AsciiProgress,
  Button,
  Callout,
  Field,
  Icon,
  Panel,
  Popup,
  SeatDot,
  StatusTag,
  useConfirm,
} from "../../ui";
import type { FacilitatorConnection } from "../connection";
import {
  type AttributionJobView,
  type AudioDeleteResult,
  type AudioDeleteScope,
  type AudioExportKind,
  type AudioExportResult,
  type AudioSessionView,
  attributionBlock,
  DELETE_SCOPES,
  deleteBlock,
  EXPORTS_NOT_DELETED,
  exportBlock,
  GRADE_TONE,
  hasCleanTrack,
  initialJobState,
  JOB_IDLE,
  JOB_POLL_MS,
  type JobState,
  jobReducer,
  progressCells,
  type SegmentsView,
  scopeSentence,
  shortSha,
  talkBars,
  timelineBars,
  timelineSpan,
  whenWall as when,
} from "./audioModel";

const whenTs = (ts: number) => when(new Date(ts).toISOString());
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

const EXPORT_KINDS: Array<{ id: AudioExportKind; label: string; tip: string }> = [
  { id: "raw", label: "Raw", tip: "Each seat's microphone as recorded" },
  {
    id: "clean",
    label: "Clean",
    tip: "Each seat's track with the moments attributed to other seats attenuated (needs a speaker attribution)",
  },
  { id: "both", label: "Both", tip: "Raw and clean WAV of each seat" },
];

/** An error message from the server, shown verbatim, with the error icon (red only for errors). */
function ErrorLine({ text }: { text: string | null }) {
  if (!text) return null;
  return (
    <span className="small t-danger" role="alert">
      <Icon name="error" /> {text}
    </span>
  );
}

/** Why an action is unavailable right now (not an error: muted). */
function BlockHint({ text }: { text: string | null }) {
  if (!text) return null;
  return <span className="hint">{text}</span>;
}

/**
 * DATABASE → one session's audio: per-seat recordings, speaker attribution
 * (loudness comparison only), speech timeline, the registered "Export audio"
 * action (the only way WAVs leave the encrypted store), previous audio exports
 * and the retention action "delete audio".
 */
export function AudioPopup({
  conn,
  sessionId,
  onClose,
  onChanged,
}: {
  conn: FacilitatorConnection;
  sessionId: string;
  onClose: () => void;
  /** Something registered changed (export, deletion, attribution): reload the DATABASE lists. */
  onChanged: () => void;
}) {
  const confirm = useConfirm();
  const [view, setView] = useState<AudioSessionView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [segments, setSegments] = useState<SegmentsView | null>(null);
  const [job, dispatch] = useReducer(jobReducer, JOB_IDLE);
  const [kind, setKind] = useState<AudioExportKind>("raw");
  const [seat, setSeat] = useState<number | "all">("all");
  const [note, setNote] = useState("");
  const [exporting, setExporting] = useState<number | "all" | null>(null);
  const [exportResult, setExportResult] = useState<AudioExportResult | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const [deleteResult, setDeleteResult] = useState<AudioDeleteResult | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const kindName = useId();
  const base = `/api/sessions/${encodeURIComponent(sessionId)}/audio`;
  /** Number of the latest load: an older, slower answer never overwrites a newer view. */
  const loadSeq = useRef(0);

  const load = useCallback(
    async (followJob = false) => {
      const seq = ++loadSeq.current;
      try {
        const v = await conn.api<AudioSessionView>(base);
        if (seq !== loadSeq.current) return;
        setView(v);
        setLoadError(null);
        if (followJob) {
          const j = initialJobState(v);
          if (j.phase === "active" && v.jobs[0]) dispatch({ type: "job", job: v.jobs[0] });
        }
        if (v.seats.length > 0 || v.deletions.length > 0) {
          const s = await conn.api<SegmentsView>(`${base}/segments`).catch(() => null);
          if (seq === loadSeq.current) setSegments(s);
        } else setSegments(null);
      } catch (e) {
        if (seq === loadSeq.current) setLoadError(errText(e));
      }
    },
    [conn, base],
  );
  useEffect(() => {
    void load(true);
  }, [load]);
  // cleaned tracks can disappear (deletion, erasure of a participant): fall back to raw
  useEffect(() => {
    if (view && kind !== "raw" && !hasCleanTrack(view)) setKind("raw");
  }, [view, kind]);

  /** A job update from the POST or a poll; a finished job reloads the view and the DATABASE lists. */
  const onJob = useCallback(
    (j: AttributionJobView) => {
      dispatch({ type: "job", job: j });
      if (j.status === "done" || j.status === "failed") {
        if (j.status === "done") conn.toast("Speaker attribution done");
        void load();
        onChanged();
      }
    },
    [conn, load, onChanged],
  );

  // poll the queued or running job; `job` is a new object on every update, so this re-arms itself
  useEffect(() => {
    if (job.phase !== "active") return;
    const jobId = job.jobId;
    let live = true;
    const t = setTimeout(() => {
      conn.api<AttributionJobView>(`/api/audio/jobs/${encodeURIComponent(jobId)}`).then(
        (j) => live && onJob(j),
        (e) => live && dispatch({ type: "error", error: errText(e) }),
      );
    }, JOB_POLL_MS);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [job, conn, onJob]);

  const runAttribution = async () => {
    if (!view) return;
    if (view.attribution) {
      const ok = await confirm({
        title: "Run the speaker attribution again",
        icon: "voice",
        confirmLabel: "Run again",
        message: (
          <p>
            The new result replaces the previous one: speech segments, talk time, the quality report and the
            cleaned tracks. Raw audio is never changed.
          </p>
        ),
      });
      if (!ok) return;
    }
    dispatch({ type: "start" });
    try {
      onJob(await conn.api<AttributionJobView>(`${base}/attribution`, { method: "POST", body: "{}" }));
    } catch (e) {
      dispatch({ type: "error", error: errText(e) });
    }
  };

  const doExport = async (seats: number | "all", k: AudioExportKind = kind) => {
    setExporting(seats);
    setExportError(null);
    try {
      const r = await conn.api<AudioExportResult>(`${base}/export`, {
        method: "POST",
        body: JSON.stringify({
          kind: k,
          sessionId,
          ...(seats === "all" ? {} : { seats: [seats] }),
          ...(note.trim() ? { note: note.trim() } : {}),
        }),
      });
      setExportResult(r);
      conn.toast(`Audio export ${r.exportId} written`, r.warnings.length ? "warn" : "ok");
      void load();
      onChanged();
    } catch (e) {
      setExportError(errText(e));
    } finally {
      setExporting(null);
    }
  };

  const deleteAudio = async () => {
    if (!view) return;
    const choice = { scope: "raw" as AudioDeleteScope, note: "" };
    const ok = await confirm({
      title: `Delete audio of ${sessionId}`,
      icon: "erase",
      danger: true,
      requireText: sessionId,
      confirmLabel: "Delete audio permanently",
      message: (
        <DeleteAudioForm view={view} onScope={(s) => (choice.scope = s)} onNote={(n) => (choice.note = n)} />
      ),
    });
    if (!ok) return;
    setDeleteError(null);
    try {
      const r = await conn.api<AudioDeleteResult>(`${base}/delete`, {
        method: "POST",
        body: JSON.stringify({
          confirm: sessionId,
          scope: choice.scope,
          ...(choice.note.trim() ? { note: choice.note.trim() } : {}),
        }),
      });
      setDeleteResult(r);
      setExportResult(null);
      conn.toast(
        `Audio deleted (${DELETE_SCOPES[r.scope].label.toLowerCase()}): ${r.counts.files} files`,
        r.audioExportsOnDisk.length || r.audioFiles.failed.length ? "warn" : "ok",
      );
      void load();
      onChanged();
    } catch (e) {
      setDeleteError(errText(e));
    }
  };

  const runBlock = view ? attributionBlock(view, job) : "Loading";
  const formBlock = view ? exportBlock(view, job, kind, seat) : "Loading";
  const delBlock = view ? deleteBlock(view, job) : "Loading";
  const exportPrimary = Boolean(view?.attribution);

  return (
    <Popup
      title={`Audio · ${sessionId}`}
      icon="voice"
      width={980}
      onClose={onClose}
      footer={
        <>
          <Button
            icon="refresh"
            tip="Reload this session's audio (e.g. while it is still recording)"
            onClick={() => void load()}
          >
            Refresh
          </Button>
          <span className="spacer" />
          <Button icon="close" kbd="Esc" onClick={onClose}>
            Done
          </Button>
        </>
      }
    >
      <div className="col" style={{ gap: "var(--s3)" }}>
        {!view && !loadError && <span className="muted cursor">Loading</span>}
        <ErrorLine text={loadError} />
        {view && (
          <>
            {view.running && (
              <Callout tone="warn" icon="live">
                This session is still running. Speaker attribution, audio export and deletion wait until it
                has ended (game complete, closed or aborted).
              </Callout>
            )}
            <SeatsPanel
              view={view}
              kind={kind}
              job={job}
              exporting={exporting}
              onExport={(s) => void doExport(s)}
            />
            <AttributionPanel
              view={view}
              job={job}
              block={runBlock}
              primary={!exportPrimary}
              onRun={() => void runAttribution()}
            />
            {segments && segments.segments.length > 0 && <TimelinePanel view={view} segments={segments} />}
            <Panel title="Export audio" icon="export" nested>
              <div className="col">
                <span className="hint">
                  Writes 16 kHz mono WAV files and a manifest (SHA-256 of every file) to the exports folder on
                  this computer, recorded in the export register. This is the only way audio leaves the
                  encrypted store. File names hold the session id and seat, never a participant code.
                </span>
                <div className="row" style={{ alignItems: "flex-end", gap: "var(--s3)" }}>
                  <fieldset className="segmented">
                    <legend>Kind</legend>
                    <div className="row" style={{ gap: "var(--s3)" }}>
                      {EXPORT_KINDS.map((k) => {
                        const off = k.id !== "raw" && !hasCleanTrack(view);
                        return (
                          <label
                            key={k.id}
                            className="row nowrap small"
                            style={{ gap: "var(--s1)" }}
                            data-tip={
                              off ? `${k.tip}. No cleaned track yet: run the attribution first.` : k.tip
                            }
                          >
                            <input
                              type="radio"
                              name={kindName}
                              checked={kind === k.id}
                              disabled={off}
                              onChange={() => setKind(k.id)}
                            />
                            <span className={off ? "faint" : ""}>{k.label}</span>
                          </label>
                        );
                      })}
                    </div>
                  </fieldset>
                  <Field label="Seats">
                    <select
                      value={String(seat)}
                      onChange={(e) => setSeat(e.target.value === "all" ? "all" : Number(e.target.value))}
                    >
                      <option value="all">All seats</option>
                      {view.seats.map((s) => (
                        <option key={s.seat} value={s.seat}>
                          Seat {s.seat}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label="Note (optional)">
                    <input
                      type="text"
                      value={note}
                      onChange={(e) => setNote(e.target.value)}
                      maxLength={500}
                      placeholder="e.g. for transcription — no names"
                      style={{ minWidth: 260 }}
                    />
                  </Field>
                  <span className="spacer" />
                  <Button
                    variant={exportPrimary ? "primary" : "secondary"}
                    icon="export"
                    disabled={formBlock !== null || exporting !== null}
                    tip={
                      formBlock ??
                      `Write the ${kind === "both" ? "raw and clean" : kind} WAV of ${seat === "all" ? "every seat" : `seat ${seat}`} to the exports folder (registered)`
                    }
                    onClick={() => void doExport(seat)}
                  >
                    {exporting !== null ? "Exporting…" : "Export audio"}
                  </Button>
                </div>
                <BlockHint text={formBlock} />
                <ErrorLine text={exportError} />
                {exportResult && <ExportResultView r={exportResult} />}
              </div>
            </Panel>
            <PreviousExports view={view} />
            <RetentionPanel
              view={view}
              block={delBlock}
              error={deleteError}
              result={deleteResult}
              onDelete={() => void deleteAudio()}
            />
          </>
        )}
      </div>
    </Popup>
  );
}

/* ─────────────────────────── Seats ─────────────────────────── */

function SeatsPanel({
  view,
  kind,
  job,
  exporting,
  onExport,
}: {
  view: AudioSessionView;
  kind: AudioExportKind;
  job: JobState;
  exporting: number | "all" | null;
  onExport: (seat: number) => void;
}) {
  return (
    <Panel title={`Seats · ${view.seats.length}`} icon="seats" nested>
      {view.seats.length === 0 ? (
        <span className="faint">
          No audio stored for this session (audio off, mic skipped, or no participant consented to audio).
        </span>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table className="grid">
            <thead>
              <tr>
                <th>Seat</th>
                <th>Tracks</th>
                <th>Recorded</th>
                <th>Gaps</th>
                <th>Track breaks</th>
                <th>Missing</th>
                <th>Stored</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {view.seats.map((s) => {
                const block = exportBlock(view, job, kind, s.seat);
                return (
                  <tr key={s.seat}>
                    <td>
                      <span className="row nowrap" style={{ gap: "var(--s1)" }}>
                        <SeatDot seat={s.seat} />
                        <strong>SEAT {s.seat}</strong>
                      </span>
                    </td>
                    <td>{s.tracks}</td>
                    <td className="mono" data-tip={`First to last sample: ${fmtDuration(s.spanMs)}`}>
                      {fmtDuration(s.durationMs)}
                    </td>
                    <td data-tip="Chunks never received inside a track">{s.gaps}</td>
                    <td data-tip="Breaks between tracks: a recording pause, reload or reconnect">
                      {s.trackBreaks}
                    </td>
                    <td className="mono" data-tip="Time between the first and last sample without audio">
                      {fmtDuration(s.missingMs)}
                    </td>
                    <td>
                      <span className="row nowrap" style={{ gap: "var(--s1)" }}>
                        {s.rawDeleted ? (
                          <StatusTag
                            icon="microphoneOff"
                            tip="The raw audio of this seat was deleted; its metadata (times, lengths) is kept"
                          >
                            raw deleted
                          </StatusTag>
                        ) : (
                          <StatusTag tip="The microphone audio as recorded (encrypted)">raw</StatusTag>
                        )}
                        {hasCleanTrack(view, s.seat) && (
                          <StatusTag tip="Cleaned track from the latest speaker attribution (encrypted)">
                            clean
                          </StatusTag>
                        )}
                      </span>
                    </td>
                    <td>
                      <Button
                        size="sm"
                        icon="export"
                        disabled={block !== null || exporting !== null}
                        tip={
                          block ??
                          `Export seat ${s.seat}'s ${kind === "both" ? "raw and clean" : kind} WAV to the exports folder on this computer (registered "Export audio")`
                        }
                        onClick={() => onExport(s.seat)}
                      >
                        {exporting === s.seat ? "Exporting…" : "WAV"}
                      </Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

/* ─────────────────────────── Attribution ─────────────────────────── */

function AttributionPanel({
  view,
  job,
  block,
  primary,
  onRun,
}: {
  view: AudioSessionView;
  job: JobState;
  block: string | null;
  primary: boolean;
  onRun: () => void;
}) {
  const a = view.attribution;
  const p = job.phase === "active" ? progressCells(job.progress) : null;
  return (
    <Panel title="Speaker attribution" icon="voice" nested>
      <div className="col">
        <span className="hint">
          Finds who spoke when by comparing the loudness of each moment between the seats' microphones. No
          voice identification: voices are never analysed or compared.
        </span>
        <div className="row">
          <Button
            variant={primary ? "primary" : "secondary"}
            icon="voice"
            disabled={block !== null}
            tip={
              block ??
              (a
                ? "Run the attribution again: the new result replaces the previous one"
                : "Run the speaker attribution of this session (takes a moment; runs on this computer)")
            }
            onClick={onRun}
          >
            {a ? "Re-run speaker attribution" : "Run speaker attribution"}
          </Button>
          {job.phase === "starting" && <span className="muted small">Starting…</span>}
          {p && job.phase === "active" && (
            <AsciiProgress
              className="small"
              used={p.pct}
              limit={100}
              width={p.on + p.off}
              filled={p.on}
              label="Speaker attribution progress"
              text={`${p.pct} % · ${job.status}`}
            />
          )}
          {a && job.phase !== "active" && job.phase !== "starting" && (
            <span className="hint">Re-running replaces the result below.</span>
          )}
        </div>
        {job.phase !== "active" && <BlockHint text={block} />}
        {job.phase === "failed" && <ErrorLine text={job.error} />}
        {a ? <AttributionResult a={a} /> : <span className="faint">No attribution yet.</span>}
      </div>
    </Panel>
  );
}

/** Memoised, like TimelinePanel: the job poll and the export note re-render the popup often. */
const AttributionResult = memo(function AttributionResult({
  a,
}: {
  a: NonNullable<AudioSessionView["attribution"]>;
}) {
  const bars = useMemo(() => talkBars(a.talkTimeMs), [a.talkTimeMs]);
  return (
    <div className="col">
      <div className="row small">
        <StatusTag
          tone={GRADE_TONE[a.grade]}
          icon={a.grade === "good" ? "ok" : "warning"}
          tip="Overall quality of the attribution, from the calibration margins, drift, coverage and ambiguous share"
        >
          {a.grade}
        </StatusTag>
        {a.quality.calibrated ? (
          <StatusTag
            tone="live"
            icon="voice"
            tip="The leakage between the microphones was measured in the calibration"
          >
            calibrated
          </StatusTag>
        ) : (
          <StatusTag
            tone="warn"
            icon="voice"
            tip="No calibration: the leakage between microphones was estimated"
          >
            not calibrated
          </StatusTag>
        )}
        <span className="muted">
          {whenTs(a.createdServerTs)} · engine {a.engineVersion} · {a.segments} segments · overlap{" "}
          <span className="mono">{fmtDuration(a.overlapMs)}</span> · ambiguous{" "}
          {fmtShare(a.quality.ambiguousShare)}
        </span>
      </div>
      <div className="grid-2" style={{ alignItems: "start" }}>
        <div className="col" style={{ gap: "var(--s1)" }}>
          <span className="label micro upper muted">Talk time</span>
          {bars.map((b) => (
            <div key={b.seat} className="row nowrap small" style={{ gap: "var(--s2)" }}>
              <SeatDot seat={b.seat} />
              <strong style={{ minWidth: "6ch" }}>SEAT {b.seat}</strong>
              <AsciiProgress
                used={b.filled}
                limit={b.width}
                width={b.width}
                text={null}
                color={`var(--seat-${b.seat})`}
              />
              <span className="mono">{fmtDuration(b.ms)}</span>
              <span className="muted">{fmtShare(b.share)}</span>
            </div>
          ))}
          <span className="hint">Overlapping speech counts for each speaker.</span>
        </div>
        <table className="grid">
          <thead>
            <tr>
              <th>Seat</th>
              <th data-tip="Calibration margin: own voice over the loudest other seat on this mic">Margin</th>
              <th data-tip="Estimated sample-clock drift of the seat's device">Drift</th>
              <th data-tip="Median lag of the channel against the common timeline after alignment">Lag</th>
              <th data-tip="Share of the recording window covered by the seat's audio">Coverage</th>
            </tr>
          </thead>
          <tbody>
            {a.quality.perSeat.map((q) => (
              <tr key={q.seat}>
                <td>
                  <span className="row nowrap" style={{ gap: "var(--s1)" }}>
                    <SeatDot seat={q.seat} />
                    {q.seat}
                  </span>
                </td>
                <td className="mono">{fmtSigned(q.marginDb, "dB")}</td>
                <td className="mono">{fmtSigned(q.driftPpm, "ppm", 0)}</td>
                <td className="mono">{fmtSigned(q.lagMs, "ms", 0)}</td>
                <td className="mono">{fmtShare(q.coverage)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {a.quality.warnings.length > 0 && (
        <Callout tone="warn" icon="warning">
          <strong>Quality warnings</strong>
          <ul style={{ margin: 0, paddingLeft: "var(--s4)" }}>
            {a.quality.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </Callout>
      )}
    </div>
  );
});

/* ─────────────────────────── Speech timeline ─────────────────────────── */

/** Memoised: a session has thousands of segments, and the popup re-renders on every poll and keystroke. */
const TimelinePanel = memo(function TimelinePanel({
  view,
  segments,
}: {
  view: AudioSessionView;
  segments: SegmentsView;
}) {
  const layout = useMemo(() => {
    const span = timelineSpan(view.seats, segments.segments);
    if (!span) return null;
    const bars = timelineBars(segments.segments, span.t0, span.t1);
    const seats = [...new Set([...view.seats.map((s) => s.seat), ...bars.keys()])].sort((a, b) => a - b);
    return { span, bars, seats };
  }, [view.seats, segments.segments]);
  if (!layout) return null;
  const { span, bars, seats } = layout;
  const at = (ts: number) => fmtDuration(ts - span.t0);
  return (
    <Panel title={`Speech timeline · ${segments.segments.length} segments`} icon="timeline" nested>
      <div className="col" style={{ gap: "var(--s1)" }}>
        <span className="hint">
          Who spoke when, from the latest attribution (times only, no audio). Hover a segment for its times.
        </span>
        {seats.map((seat) => (
          <div key={seat} className="row nowrap small" style={{ gap: "var(--s2)" }}>
            <SeatDot seat={seat} />
            <strong style={{ minWidth: "6ch" }}>SEAT {seat}</strong>
            <div
              role="img"
              aria-label={`Seat ${seat}: ${bars.get(seat)?.length ?? 0} speech segments`}
              style={{
                position: "relative",
                flex: 1,
                height: "1em",
                borderBottom: "1px dashed var(--frame)",
              }}
            >
              {(bars.get(seat) ?? []).map((b) => (
                <span
                  key={`${b.segment.startTs}-${b.segment.endTs}`}
                  data-tip={`Seat ${seat} · ${at(b.segment.startTs)}–${at(b.segment.endTs)} (${fmtDuration(b.segment.durationMs)})${b.segment.round ? ` · round ${b.segment.round}` : ""}${b.overlap ? ` · overlaps seat ${b.segment.overlapWith.join(", ")}` : ""}`}
                  style={{
                    position: "absolute",
                    left: `${b.left}%`,
                    width: `${b.width}%`,
                    top: "15%",
                    bottom: "15%",
                    background: `var(--seat-${seat})`,
                  }}
                />
              ))}
            </div>
          </div>
        ))}
        <div className="row nowrap micro faint" style={{ paddingLeft: "calc(6ch + 0.8em + var(--s2) * 2)" }}>
          <span>0:00</span>
          <span className="spacer" />
          <span>{fmtDuration(span.t1 - span.t0)}</span>
        </div>
      </div>
    </Panel>
  );
});

/* ─────────────────────────── Export result and previous exports ─────────────────────────── */

function ExportResultView({ r }: { r: AudioExportResult }) {
  return (
    <Callout tone="warn" icon="export">
      <strong>audio export {r.exportId}</strong> → <code>{r.dir}</code>
      <table className="grid" style={{ margin: "var(--s1) 0" }}>
        <thead>
          <tr>
            <th>File</th>
            <th>Length</th>
            <th>Size</th>
            <th>SHA-256</th>
          </tr>
        </thead>
        <tbody>
          {r.files.map((f) => (
            <tr key={f.name}>
              <td className="mono small">{f.name}</td>
              <td className="mono">{fmtDuration(f.durationMs)}</td>
              <td className="mono">{fmtBytes(f.bytes)}</td>
              <td className="mono small" data-tip={f.sha256}>
                {shortSha(f.sha256)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <span className="muted">
        Timing:{" "}
        {r.timing === "attribution"
          ? "aligned by the latest speaker attribution"
          : "the chunks' timestamps (no attribution of these tracks)"}
        .
      </span>
      {r.warnings.length > 0 && (
        <ul className="t-warn" style={{ margin: "var(--s1) 0 0", paddingLeft: "var(--s4)" }}>
          {r.warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      )}
      <br />
      Voice recordings are personal data: move the folder to institutional storage and delete the local copy.
    </Callout>
  );
}

function PreviousExports({ view }: { view: AudioSessionView }) {
  return (
    <Panel title={`Previous audio exports · ${view.audioExports.length}`} icon="register" nested>
      {view.audioExports.length === 0 ? (
        <span className="faint">No audio exports of this session yet.</span>
      ) : (
        <div style={{ maxHeight: 200, overflow: "auto" }}>
          <table className="grid">
            <thead>
              <tr>
                <th>Export</th>
                <th>Written</th>
                <th>Kind</th>
                <th>Seats</th>
                <th>Files</th>
                <th>Folder</th>
              </tr>
            </thead>
            <tbody>
              {view.audioExports.map((x) => (
                <tr key={x.exportId}>
                  <td className="mono small">{x.exportId}</td>
                  <td className="small">{when(x.createdWall)}</td>
                  <td>{x.audioKind ?? PLACEHOLDER}</td>
                  <td>{x.seats.length ? x.seats.join(", ") : PLACEHOLDER}</td>
                  <td>{x.files}</td>
                  <td>
                    <span className="row nowrap" style={{ gap: "var(--s1)" }}>
                      {x.onDisk ? (
                        <StatusTag
                          tone="warn"
                          icon="warning"
                          tip="The WAV files are still in the exports folder"
                        >
                          on disk
                        </StatusTag>
                      ) : (
                        <StatusTag tip="The folder is no longer in the exports folder (moved or deleted)">
                          gone
                        </StatusTag>
                      )}
                      <code className="small">{x.path}</code>
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

/* ─────────────────────────── Retention: delete audio ─────────────────────────── */

function RetentionPanel({
  view,
  block,
  error,
  result,
  onDelete,
}: {
  view: AudioSessionView;
  block: string | null;
  error: string | null;
  result: AudioDeleteResult | null;
  onDelete: () => void;
}) {
  return (
    <Panel title="Retention · delete audio" icon="erase" nested>
      <div className="col">
        <span className="hint">
          <strong>Raw audio, keep derived:</strong> {scopeSentence("raw")}
          <br />
          <strong>All audio:</strong> {scopeSentence("all")}
        </span>
        <div className="row">
          <span className="spacer" />
          <Button
            variant="danger"
            icon="erase"
            disabled={block !== null}
            tip={block ?? "Delete this session's audio (asks you to choose what and to type the session id)"}
            onClick={onDelete}
          >
            Delete audio…
          </Button>
        </div>
        <BlockHint text={block} />
        <ErrorLine text={error} />
        {result && <DeleteResultView r={result} />}
        {view.deletions.length > 0 && (
          <table className="grid">
            <thead>
              <tr>
                <th>#</th>
                <th>Executed</th>
                <th>Scope</th>
                <th>Seats</th>
                <th>Deleted</th>
                <th>Note</th>
              </tr>
            </thead>
            <tbody>
              {view.deletions.map((d) => (
                <tr key={d.id}>
                  <td>{d.id}</td>
                  <td className="small">{when(d.executedWall)}</td>
                  <td>{d.scope}</td>
                  <td>{d.seats.join(", ") || PLACEHOLDER}</td>
                  <td className="small">
                    {d.tracks} tracks · {d.derivatives} derived · {fmtBytes(d.bytes)}
                  </td>
                  <td className="small">{d.note}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </Panel>
  );
}

function DeleteResultView({ r }: { r: AudioDeleteResult }) {
  const warn = r.audioExportsOnDisk.length > 0 || r.audioFiles.failed.length > 0;
  return (
    <Callout tone={warn ? "warn" : "live"} icon={warn ? "warning" : "ok"}>
      <strong>
        Register entry #{r.record.id} · {DELETE_SCOPES[r.scope].label.toLowerCase()}
      </strong>{" "}
      · {when(r.record.executedWall)} · seats {r.record.seats.join(", ") || PLACEHOLDER}
      <br />
      {r.counts.tracks} tracks ({fmtDuration(r.counts.audioMs)}) · {r.counts.derivatives} derived results ·{" "}
      {r.counts.files} encrypted files ({fmtBytes(r.counts.bytes)}), {r.audioFiles.removed} removed from disk
      {r.record.note && <> · note: {r.record.note}</>}
      {r.audioFiles.failed.length > 0 && (
        <>
          <br />
          <span className="t-danger">
            <Icon name="error" /> Could not remove (unreadable, keys gone; delete by hand):{" "}
            {r.audioFiles.failed.join(", ")}
          </span>
        </>
      )}
      {r.audioExportsOnDisk.length > 0 && (
        <>
          <br />
          Audio exports still on disk (not deleted): <code>{r.audioExportsOnDisk.join(", ")}</code>. Delete
          them by hand, and any copies elsewhere.
        </>
      )}
    </Callout>
  );
}

/** The deletion choices inside the typed confirmation: scope (with what it keeps) and a note. */
function DeleteAudioForm({
  view,
  onScope,
  onNote,
}: {
  view: AudioSessionView;
  onScope: (s: AudioDeleteScope) => void;
  onNote: (n: string) => void;
}) {
  const [scope, setScope] = useState<AudioDeleteScope>("raw");
  const [note, setNote] = useState("");
  const name = useId();
  const stored = view.seats.filter((s) => !s.rawDeleted);
  return (
    <div className="col">
      <p>
        Deletes audio of session <span className="mono">{view.sessionId}</span> ({stored.length} seat(s) with
        raw audio, {fmtDuration(stored.reduce((n, s) => n + s.durationMs, 0))} recorded). The encrypted files
        and their keys are destroyed: this cannot be undone.
      </p>
      <fieldset className="segmented">
        <legend>What to delete</legend>
        <div className="col" style={{ gap: "var(--s2)" }}>
          {(["raw", "all"] as const).map((s) => (
            <label key={s} className="check">
              <input
                type="radio"
                name={name}
                checked={scope === s}
                onChange={() => {
                  setScope(s);
                  onScope(s);
                }}
              />
              <span>
                <strong>{DELETE_SCOPES[s].label}</strong>
                <div className="hint">{scopeSentence(s)}</div>
              </span>
            </label>
          ))}
        </div>
      </fieldset>
      <p className="t-warn small">
        <Icon name="warning" /> {EXPORTS_NOT_DELETED}
        {view.audioExports.some((x) => x.onDisk) &&
          ` On disk now: ${view.audioExports
            .filter((x) => x.onDisk)
            .map((x) => x.path)
            .join(", ")}.`}
      </p>
      <Field label="Note (optional)" hint="e.g. the retention rule applied — no names">
        <input
          type="text"
          value={note}
          maxLength={500}
          onChange={(e) => {
            setNote(e.target.value);
            onNote(e.target.value);
          }}
        />
      </Field>
    </div>
  );
}
