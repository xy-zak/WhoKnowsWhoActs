import { normaliseParticipantCode } from "@wkwa/shared";
import { useCallback, useEffect, useState } from "react";
import { Button, Callout, Chip, Field, Icon, Panel, StatusTag, useConfirm } from "../ui";
import type { FacilitatorConnection } from "./connection";

interface SessionSummary {
  id: string;
  createdWall: string;
  updatedWall: string;
  scenarioId: string;
  scenarioVersion: string;
  status: string;
  tags: string[];
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

const when = (w: string) => w.replace("T", " ").slice(0, 16);

const STATUS_TONE: Record<string, "live" | "warn" | "danger" | "neutral" | "primary"> = {
  lobby: "primary",
  onboarding: "live",
  round_active: "live",
  round_complete: "live",
  game_complete: "warn",
  closed: "neutral",
  aborted: "danger",
};

/**
 * DATABASE tab, in order of use: 1 sessions (resume · replay · export · print)
 * → 2 exports register → 3 takedown / erasure → 4 erasure register.
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
  const [exports, setExports] = useState<ExportRow[]>([]);
  const [erasures, setErasures] = useState<Erasure[]>([]);
  const [lastExport, setLastExport] = useState<ExportResult | null>(null);
  const [filter, setFilter] = useState("");
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

  const shown = sessions.filter(
    (s) =>
      !filter ||
      s.id.toLowerCase().includes(filter.toLowerCase()) ||
      s.tags.some((t) => t.toLowerCase().includes(filter.toLowerCase())),
  );

  return (
    <div className="col" style={{ gap: "var(--s3)" }}>
      <Panel
        title={`1 · Sessions · ${sessions.length}`}
        icon="database"
        actions={
          <Button size="sm" icon="refresh" onClick={refresh}>
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
                        {s.tags.map((t) => (
                          <Chip key={t}>{t}</Chip>
                        ))}
                      </span>
                    </td>
                    <td>{s.eventCount}</td>
                    <td>{s.telemetryCount}</td>
                    <td>
                      <div className="row" style={{ gap: 4, justifyContent: "flex-end" }}>
                        {s.id !== attachedId && !["closed", "aborted"].includes(s.status) && (
                          <Button
                            size="sm"
                            icon="resumeSession"
                            onClick={() =>
                              conn
                                .cmd("session:resume", { sessionId: s.id }, "Session resumed")
                                .then(onResumed, () => {})
                            }
                          >
                            Resume
                          </Button>
                        )}
                        <Button size="sm" icon="replay" onClick={() => onReplay(s.id)}>
                          Replay
                        </Button>
                        <Button size="sm" icon="export" onClick={() => void doExport(s.id, "export")}>
                          Export
                        </Button>
                        <Button size="sm" icon="anonymise" onClick={() => void doExport(s.id, "anonymise")}>
                          Anonymised
                        </Button>
                        <Button
                          size="sm"
                          icon="keysheet"
                          title="Key sheet"
                          onClick={() =>
                            void conn.openPrintable(`/api/sessions/${s.id}/print/keysheet`).catch(() => {})
                          }
                        >
                          Key sheet
                        </Button>
                        <Button
                          size="sm"
                          icon="cards"
                          onClick={() =>
                            void conn.openPrintable(`/api/sessions/${s.id}/print/cards`).catch(() => {})
                          }
                        >
                          Cards
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
                {shown.length === 0 && (
                  <tr>
                    <td colSpan={8} className="faint">
                      {sessions.length
                        ? "No session matches the filter."
                        : "No sessions yet — create one in SETUP."}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          {lastExport && (
            <Callout
              tone={lastExport.kind === "standard" ? "warn" : "live"}
              icon={lastExport.kind === "standard" ? "export" : "anonymise"}
            >
              <strong>
                {lastExport.kind} export {lastExport.exportId}
              </strong>{" "}
              → <code>{lastExport.dir}</code>
              <br />
              {lastExport.files.map((f) => `${f.name} (${f.rows})`).join(" · ")}
              {lastExport.kind === "standard" && (
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
        <ErasurePanel conn={conn} onDone={refresh} />
        <div className="col">
          <Panel title={`2 · Exports · ${exports.length}`} icon="register">
            <div style={{ maxHeight: 260, overflow: "auto" }}>
              <table className="grid">
                <tbody>
                  {exports.map((x) => (
                    <tr key={x.id}>
                      <td className="mono small">{x.id}</td>
                      <td>
                        <StatusTag
                          tone={x.kind === "anonymised" ? "live" : "warn"}
                          icon={x.kind === "anonymised" ? "anonymise" : "export"}
                        >
                          {x.kind}
                        </StatusTag>
                      </td>
                      <td className="mono small">{x.sessionId}</td>
                      <td className="small">{when(x.createdWall)}</td>
                    </tr>
                  ))}
                  {exports.length === 0 && (
                    <tr>
                      <td className="faint">No exports yet.</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </Panel>
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
        </div>
      </div>
    </div>
  );
}

function ErasurePanel({ conn, onDone }: { conn: FacilitatorConnection; onDone: () => void }) {
  const confirm = useConfirm();
  const [input, setInput] = useState("");
  const [look, setLook] = useState<Lookup | null>(null);
  const [note, setNote] = useState("");
  const [result, setResult] = useState<string | null>(null);
  const code = normaliseParticipantCode(input);

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
            <span className="mono">{look.code}</span> in {look.occurrences.length} session(s). This cannot be
            undone.
          </p>
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
      .api<{ rows: { events: number; telemetry: number }; exports: ExportRow[] }>(
        `/api/participants/${look.code}/erase`,
        {
          method: "POST",
          body: JSON.stringify({ confirm: look.code, note }),
        },
      )
      .catch(() => null);
    if (!r) return;
    setResult(
      `Erased ${r.rows.events} events and ${r.rows.telemetry} telemetry rows.` +
        (r.exports.length
          ? ` Delete and regenerate on every copy: ${r.exports.map((e) => e.path).join(", ")}.`
          : "") +
        " Cross out the line on the key sheet. Backups made earlier still contain the data.",
    );
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
          <Button type="submit" icon="search" disabled={!code}>
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
                  <Button variant="danger" icon="erase" onClick={() => void erase()}>
                    Erase…
                  </Button>
                </div>
              </>
            )}
          </div>
        )}
        {result && (
          <Callout tone="live" icon="ok">
            {result}
          </Callout>
        )}
      </div>
    </Panel>
  );
}
