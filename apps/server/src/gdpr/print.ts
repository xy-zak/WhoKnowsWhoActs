import { type GameState, reduceEvents, type StudyConfig } from "@wkwa/shared";
import type { Store } from "../db/store";

const esc = (s: unknown) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );

const PAGE_CSS = `
  body { font-family: system-ui, sans-serif; margin: 2rem; color: #111; }
  .noprint { margin-bottom: 1rem; }
  @media print { .noprint { display: none; } body { margin: 0; } }
  table { border-collapse: collapse; width: 100%; }
  th, td { border: 1px solid #444; padding: 10px; text-align: left; vertical-align: top; }
  th { background: #eee; }
  .code { font-family: ui-monospace, Menlo, monospace; font-size: 1.2rem; font-weight: 700; letter-spacing: .05em; }
  .warn { border: 2px solid #b00; color: #b00; padding: .6rem 1rem; font-weight: 600; margin: 1rem 0; }
`;

function seats(state: GameState) {
  return Object.values(state.seats)
    .filter((s) => s.participantCode)
    .sort((a, b) => a.seat - b.seat);
}

/**
 * Key sheet: the ONLY place where a participant code meets a name — and the
 * name is written by hand on paper. Keep it physically separate from the data.
 */
export function keySheetHtml(store: Store, sessionId: string, study: StudyConfig): string {
  const row = store.getSession(sessionId);
  if (!row) throw new Error("Unknown session");
  const state = reduceEvents(store.listEvents(sessionId));
  const lines = seats(state)
    .map(
      (s) => `<tr><td>${s.seat}</td><td>${esc(s.terminal)}</td><td class="code">${esc(s.participantCode)}</td>
      <td style="width:35%"></td><td style="width:20%"></td></tr>`,
    )
    .join("");
  return `<!doctype html><html><head><meta charset="utf-8"><title>Key sheet ${esc(sessionId)}</title><style>${PAGE_CSS}</style></head><body>
  <div class="noprint"><button onclick="print()">Print</button> Print this page, fill in the names by hand, then close it. Do not save it as a file.</div>
  <h1>Key sheet — ${esc(study.title)}</h1>
  <p>Session <strong>${esc(sessionId)}</strong> · created ${esc(row.created_wall.slice(0, 10))} · scenario ${esc(row.scenario_id)} v${esc(row.scenario_version)}</p>
  <div class="warn">CONFIDENTIAL — links participant codes to names. Store separately from all research data (e.g. locked drawer).
  Destroy (shred) on: ______________________ &nbsp; Destroyed on: ______________________ by: __________</div>
  <table><thead><tr><th>Seat</th><th>Terminal</th><th>Participant code</th><th>Name (handwritten)</th><th>Notes</th></tr></thead>
  <tbody>${lines || `<tr><td colspan="5">No seats bound yet.</td></tr>`}</tbody></table>
  <p style="font-size:.85rem">${esc(study.retention)}</p>
  </body></html>`;
}

/** Takedown cards: one per participant, handed out at the end of the session. */
export function takedownCardsHtml(store: Store, sessionId: string, study: StudyConfig): string {
  if (!store.getSession(sessionId)) throw new Error("Unknown session");
  const state = reduceEvents(store.listEvents(sessionId));
  const cards = seats(state)
    .map(
      (s) => `<div class="card">
        <div class="t">${esc(study.title)}</div>
        <div>Your participant code</div>
        <div class="code big">${esc(s.participantCode)}</div>
        <p>${esc(study.takedownInstructions)}</p>
        <p><strong>Contact:</strong> ${esc(study.researcher)} — ${esc(study.contactEmail)}</p>
        <div class="seat">seat ${s.seat}</div>
      </div>`,
    )
    .join("");
  return `<!doctype html><html><head><meta charset="utf-8"><title>Takedown cards ${esc(sessionId)}</title><style>${PAGE_CSS}
    .cards { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
    .card { border: 2px dashed #444; border-radius: 8px; padding: 14px 18px; break-inside: avoid; position: relative; }
    .card .t { font-weight: 700; margin-bottom: 6px; }
    .card .big { font-size: 1.6rem; margin: 6px 0 4px; }
    .card p { font-size: .9rem; margin: 6px 0; }
    .card .seat { position: absolute; right: 12px; top: 10px; font-size: .75rem; color: #666; }
  </style></head><body>
  <div class="noprint"><button onclick="print()">Print</button> Cut along the dashed lines; give each participant the card of their seat.</div>
  <div class="cards">${cards || "<p>No seats bound yet.</p>"}</div>
  </body></html>`;
}
