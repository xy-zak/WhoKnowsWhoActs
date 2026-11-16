import { normaliseParticipantCode } from "@wkwa/shared";
import { useCallback, useEffect, useState } from "react";
import type { FacilitatorConnection } from "./connection";
import { ConfirmButton } from "./Live";

interface SessionSummary {
  id: string;
  createdWall: string;
  updatedWall: string;
  scenarioId: string;
  scenarioVersion: string;
  status: string;
  condition: string;
  notes: string;
  eventCount: number;
  telemetryCount: number;
}
interface ExportResult {
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
  occurrences: Array<{ sessionId: string; seat: number | null; events: number; telemetry: number }>;
  exports: ExportRow[];
  previouslyErased: Array<{ executedWall: string }>;
}
interface Erasure {
  id: number;
  codeSha256: string;
  executedWall: string;
  sessions: Array<{ sessionId: string }>;
  rows: { events: number; telemetry: number };
  note: string;
}

export function DataPanel({
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
  const [exports, setExports] = useState<ExportRow[]>([]);
  const [erasures, setErasures] = useState<Erasure[]>([]);
  const [lastExport, setLastExport] = useState<ExportResult | null>(null);
  const refresh = useCallback(() => {
    conn.api<SessionSummary[]>("/api/sessions").then(setSessions, () => {});
    conn.api<ExportRow[]>("/api/exports").then(setExports, () => {});
    conn.api<Erasure[]>("/api/erasures").then(setErasures, () => {});
  }, [conn]);
  useEffect(refresh, [refresh]);

  const doExport = async (id: string, kind: "export" | "anonymise") => {
    const r = await conn
      .api<ExportResult>(`/api/sessions/${id}/${kind}`, { method: "POST" })
      .catch(() => null);
    if (r) {
      setLastExport(r);
      conn.toast(`${r.kind} export written`);
      refresh();
    }
  };

  return (
    <div className="col" style={{ gap: 10 }}>
      <div className="panel col">
        <div className="row">
          <h2 style={{ margin: 0 }}>Sessions</h2>
          <span className="spacer" />
          <button type="button" onClick={refresh}>
            Refresh
          </button>
        </div>
        <div style={{ overflowX: "auto" }}>
          <table className="grid">
            <thead>
              <tr>
                <th>Session</th>
                <th>Created</th>
                <th>Status</th>
                <th>Scenario</th>
                <th>Condition</th>
                <th>Events</th>
                <th>Telemetry</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {sessions.map((s) => (
                <tr key={s.id}>
                  <td className="mono">
                    {s.id} {s.id === attachedId && <span className="pill ok">attached</span>}
                  </td>
                  <td className="small">{s.createdWall.replace("T", " ").slice(0, 16)}</td>
                  <td>{s.status}</td>
                  <td className="small">
                    {s.scenarioId} v{s.scenarioVersion}
                  </td>
                  <td className="small">{s.condition}</td>
                  <td>{s.eventCount}</td>
                  <td>{s.telemetryCount}</td>
                  <td>
                    <div className="row" style={{ gap: 4 }}>
                      {s.id !== attachedId && !["closed", "aborted"].includes(s.status) && (
                        <button
                          type="button"
                          className="small"
                          onClick={() =>
                            conn
                              .cmd("session:resume", { sessionId: s.id }, "Session resumed")
                              .then(onResumed, () => {})
                          }
                        >
                          Resume
                        </button>
                      )}
                      <button type="button" className="small" onClick={() => onReplay(s.id)}>
                        Replay
                      </button>
                      <button type="button" className="small" onClick={() => doExport(s.id, "export")}>
                        Export
                      </button>
                      <button type="button" className="small" onClick={() => doExport(s.id, "anonymise")}>
                        Anonymised export
                      </button>
                      <button
                        type="button"
                        className="small"
                        onClick={() =>
                          void conn.openPrintable(`/api/sessions/${s.id}/print/keysheet`).catch(() => {})
                        }
                      >
                        Key sheet
                      </button>
                      <button
                        type="button"
                        className="small"
                        onClick={() =>
                          void conn.openPrintable(`/api/sessions/${s.id}/print/cards`).catch(() => {})
                        }
                      >
                        Takedown cards
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
              {sessions.length === 0 && (
                <tr>
                  <td colSpan={8} className="muted">
                    No sessions yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        {lastExport && (
          <div className="banner small">
            <strong>
              {lastExport.kind} export {lastExport.exportId}
            </strong>{" "}
            written to <code>{lastExport.dir}</code> —{" "}
            {lastExport.files.map((f) => `${f.name} (${f.rows})`).join(", ")}.{" "}
            {lastExport.kind === "standard" &&
              "Contains pseudonymised personal data: move it to institutional storage and delete the local copy."}
          </div>
        )}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, alignItems: "start" }}>
        <ErasurePanel conn={conn} onDone={refresh} />
        <div className="panel col">
          <h2 style={{ margin: 0 }}>Erasure register</h2>
          <span className="small muted">
            Only SHA-256 hashes of erased codes are kept, to re-apply erasures after restoring a backup.
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
                  <td className="small">{e.executedWall.replace("T", " ").slice(0, 16)}</td>
                  <td className="mono small">{e.codeSha256.slice(0, 12)}…</td>
                  <td className="small">
                    {e.rows.events} ev · {e.rows.telemetry} tel
                  </td>
                  <td className="small">{e.note}</td>
                </tr>
              ))}
              {erasures.length === 0 && (
                <tr>
                  <td colSpan={5} className="muted">
                    empty
                  </td>
                </tr>
              )}
            </tbody>
          </table>
          <h2 style={{ margin: "10px 0 0" }}>Exports</h2>
          <table className="grid">
            <tbody>
              {exports.slice(0, 30).map((x) => (
                <tr key={x.id}>
                  <td className="mono small">{x.id}</td>
                  <td>{x.kind}</td>
                  <td className="mono small">{x.sessionId}</td>
                  <td className="small">{x.createdWall.replace("T", " ").slice(0, 16)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function ErasurePanel({ conn, onDone }: { conn: FacilitatorConnection; onDone: () => void }) {
  const [input, setInput] = useState("");
  const [look, setLook] = useState<Lookup | null>(null);
  const [confirm, setConfirm] = useState("");
  const [note, setNote] = useState("");
  const [result, setResult] = useState<string | null>(null);
  const code = normaliseParticipantCode(input);

  const lookup = async () => {
    setResult(null);
    setConfirm("");
    const r = await conn.api<Lookup>(`/api/participants/${encodeURIComponent(input)}`).catch(() => null);
    setLook(r);
  };
  const erase = async () => {
    if (!look) return;
    const r = await conn
      .api<{ rows: { events: number; telemetry: number }; exports: ExportRow[] }>(
        `/api/participants/${look.code}/erase`,
        {
          method: "POST",
          body: JSON.stringify({ confirm, note }),
        },
      )
      .catch(() => null);
    if (!r) return;
    setResult(
      `Erased ${r.rows.events} events and ${r.rows.telemetry} telemetry rows.` +
        (r.exports.length
          ? ` Delete and regenerate these exports on every copy: ${r.exports.map((e) => e.path).join(", ")}.`
          : "") +
        " Cross out the line on the key sheet. Backups made earlier still contain the data.",
    );
    setLook(null);
    setInput("");
    setConfirm("");
    onDone();
  };

  return (
    <div className="panel col">
      <h2 style={{ margin: 0 }}>Takedown / erasure</h2>
      <span className="small muted">
        Enter the code from the participant's request (or from the key sheet). Typos are detected by the check
        character.
      </span>
      <div className="row">
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="WK-XXXX-XXXX-X"
          className="mono"
          style={{ flex: 1 }}
        />
        <button type="button" disabled={!code} onClick={lookup}>
          Look up
        </button>
      </div>
      {input && !code && (
        <span className="small" style={{ color: "var(--danger)" }}>
          Not a valid participant code.
        </span>
      )}
      {look && (
        <div className="col">
          <strong className="mono">{look.code}</strong>
          {look.occurrences.length === 0 ? (
            <span className="muted">
              No data stored for this code.
              {look.previouslyErased.length > 0 &&
                ` It was erased on ${look.previouslyErased.map((p) => p.executedWall.slice(0, 10)).join(", ")}.`}
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
                    </tr>
                  ))}
                </tbody>
              </table>
              {look.exports.length > 0 && (
                <span className="small">
                  Contained in {look.exports.length} export(s): {look.exports.map((e) => e.id).join(", ")}
                </span>
              )}
              <label className="col" style={{ gap: 2 }}>
                <span className="small">Type the code again to confirm permanent erasure:</span>
                <input
                  type="text"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  className="mono"
                />
              </label>
              <input
                type="text"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="Optional note (e.g. request date) — no names"
                maxLength={200}
              />
              <ConfirmButton
                label="Erase all data of this participant"
                confirmLabel="This cannot be undone — click again"
                className="danger"
                disabled={normaliseParticipantCode(confirm) !== look.code}
                onConfirm={erase}
              />
            </>
          )}
        </div>
      )}
      {result && <div className="banner small">{result}</div>}
    </div>
  );
}
