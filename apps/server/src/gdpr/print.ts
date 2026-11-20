import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { type GameState, reduceEvents, type StudyConfig } from "@wkwa/shared";
import PDFDocument from "pdfkit";
import type { Store } from "../db/store";

/* Printables use the app's font (JetBrains Mono) and its TUI look, in black & white for printing. */

const require = createRequire(import.meta.url);
const FONT_FILES = {
  regular: require.resolve("@fontsource/jetbrains-mono/files/jetbrains-mono-latin-400-normal.woff"),
  bold: require.resolve("@fontsource/jetbrains-mono/files/jetbrains-mono-latin-700-normal.woff"),
  regular2: require.resolve("@fontsource/jetbrains-mono/files/jetbrains-mono-latin-400-normal.woff2"),
  bold2: require.resolve("@fontsource/jetbrains-mono/files/jetbrains-mono-latin-700-normal.woff2"),
};
let fontCss: string | null = null;
/** @font-face rules with the font embedded, so the page works offline and from a blob: URL. */
function embeddedFontCss(): string {
  if (fontCss) return fontCss;
  const b64 = (f: string) => readFileSync(f).toString("base64");
  fontCss = `
  @font-face { font-family: "JetBrains Mono"; font-weight: 400; src: url(data:font/woff2;base64,${b64(FONT_FILES.regular2)}) format("woff2"); }
  @font-face { font-family: "JetBrains Mono"; font-weight: 700; src: url(data:font/woff2;base64,${b64(FONT_FILES.bold2)}) format("woff2"); }`;
  return fontCss;
}

const esc = (s: unknown) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );

function seats(state: GameState) {
  return Object.values(state.seats)
    .filter((s) => s.participantCode)
    .sort((a, b) => a.seat - b.seat);
}

/* ─────────────────────────── Key sheet (HTML, printed) ─────────────────────────── */

const KEYSHEET_CSS = `
  * { box-sizing: border-box; }
  body { font-family: "JetBrains Mono", ui-monospace, Menlo, monospace; font-size: 12px; margin: 24px; color: #111; background: #fff; }
  .noprint { margin-bottom: 16px; display: flex; gap: 12px; align-items: center; }
  .noprint button { font: inherit; font-weight: 700; text-transform: uppercase; letter-spacing: .06em; padding: 6px 12px; border: 1px solid #111; background: #fff; cursor: pointer; }
  .noprint button::before { content: "[ "; } .noprint button::after { content: " ]"; }
  @media print { .noprint { display: none; } body { margin: 0; } }
  .frame { position: relative; border: 1px solid #111; padding: 22px 16px 16px; margin-top: 10px; }
  .frame > .title { position: absolute; top: -0.8em; left: 10px; background: #fff; padding: 0 6px; font-weight: 700; text-transform: uppercase; letter-spacing: .12em; }
  h1 { font-size: 16px; text-transform: uppercase; letter-spacing: .1em; margin: 0 0 6px; }
  .meta { color: #444; margin: 0 0 14px; }
  .warn { border: 2px solid #111; padding: 8px 12px; margin: 0 0 16px; font-weight: 700; }
  .warn::before { content: "[!] "; }
  table { border-collapse: collapse; width: 100%; }
  th, td { border-bottom: 1px dashed #777; padding: 12px 8px; text-align: left; vertical-align: bottom; }
  th { border-bottom: 1px solid #111; font-size: 10px; text-transform: uppercase; letter-spacing: .1em; color: #444; }
  td.code { font-weight: 700; font-size: 14px; letter-spacing: .06em; white-space: nowrap; }
  td.write { border-bottom: 1px solid #111; }
  .foot { color: #444; font-size: 10px; margin-top: 14px; }
`;

/**
 * Key sheet: the ONLY place where a participant code meets a name — and the
 * name is written by hand on paper. Keep it physically separate from the data.
 */
export function keySheetHtml(store: Store, sessionId: string, study: StudyConfig): string {
  const row = store.requireSession(sessionId);
  const state = reduceEvents(store.listEvents(sessionId));
  // fake players (test clients the server created) are listed so the sheet covers every seat, but get no name
  const shown = Object.values(state.seats)
    .filter((s) => s.participantCode || (s.bound && s.fake))
    .sort((a, b) => a.seat - b.seat);
  const lines = shown
    .map((s) =>
      s.fake
        ? `<tr><td>${s.seat}</td><td>${esc(s.terminal)}</td><td class="code">FAKE PLAYER</td><td colspan="2">— test client created by the server: no participant, no name —</td></tr>`
        : `<tr><td>${s.seat}</td><td>${esc(s.terminal)}</td><td class="code">${esc(s.participantCode)}</td><td class="write" style="width:38%"></td><td class="write" style="width:22%"></td></tr>`,
    )
    .join("");
  return `<!doctype html><html><head><meta charset="utf-8"><title>Key sheet ${esc(sessionId)}</title><style>${embeddedFontCss()}${KEYSHEET_CSS}</style></head><body>
  <div class="noprint"><button onclick="print()">Print</button><span>Print this page, fill in the names by hand, then close it. Do not save it as a file.</span></div>
  <div class="frame"><span class="title">─ Key sheet</span>
  <h1>${esc(study.title)}</h1>
  <p class="meta">SESSION ${esc(sessionId)} · ${esc(row.created_wall.slice(0, 10))} · SCENARIO ${esc(row.scenario_id)} v${esc(row.scenario_version)}</p>
  <div class="warn">CONFIDENTIAL — links participant codes to names. Store separately from all research data (e.g. a locked drawer).<br>
  Destroy (shred) on: ____________________ &nbsp; Destroyed on: ____________________ by: __________</div>
  <table><thead><tr><th>Seat</th><th>Client</th><th>Participant code</th><th>Name (handwritten)</th><th>Notes</th></tr></thead>
  <tbody>${lines || `<tr><td colspan="5">No seats bound yet.</td></tr>`}</tbody></table>
  <p class="foot">${esc(study.retention)}</p>
  </div></body></html>`;
}

/* ─────────────────────────── Takedown card (one PDF per seat) ─────────────────────────── */

/** Seats of a session that have a participant code (cards can be made for them). */
export function cardSeats(store: Store, sessionId: string): number[] {
  store.requireSession(sessionId);
  return seats(reduceEvents(store.listEvents(sessionId))).map((s) => s.seat);
}

/**
 * One takedown card as an A6 landscape PDF, in JetBrains Mono, TUI-styled
 * (frame with inset title, bracketed labels), black on white.
 */
export function takedownCardPdf(
  store: Store,
  sessionId: string,
  seat: number,
  study: StudyConfig,
): Promise<Buffer> {
  const row = store.requireSession(sessionId);
  const s = seats(reduceEvents(store.listEvents(sessionId))).find((x) => x.seat === seat);
  if (!s?.participantCode) throw new Error(`Seat ${seat} has no participant code`);

  const doc = new PDFDocument({
    size: "A6",
    layout: "landscape",
    margin: 0,
    info: { Title: `Takedown card · ${study.title}`, Subject: "Participant code for data withdrawal" },
  });
  doc.registerFont("mono", FONT_FILES.regular);
  doc.registerFont("mono-bold", FONT_FILES.bold);
  const chunks: Buffer[] = [];
  doc.on("data", (c: Buffer) => chunks.push(c));

  const W = doc.page.width;
  const H = doc.page.height;
  const m = 18;
  const x = m + 12;
  const inner = W - 2 * x;
  const grey = "#555555";

  // frame with inset title (like the app's panels)
  doc
    .lineWidth(1)
    .strokeColor("#111111")
    .rect(m, m, W - 2 * m, H - 2 * m)
    .stroke();
  // inset title "─ TAKEDOWN CARD": the font's Latin subset has no box-drawing glyphs, so the dash is drawn
  const title = "TAKEDOWN CARD";
  doc.font("mono-bold").fontSize(8);
  const tw = doc.widthOfString(title, { characterSpacing: 1 });
  doc.rect(m + 10, m - 6, tw + 22, 12).fill("#ffffff");
  doc
    .lineWidth(1)
    .strokeColor("#111111")
    .moveTo(m + 13, m)
    .lineTo(m + 20, m)
    .stroke();
  doc.fillColor("#111111").text(title, m + 26, m - 4, { characterSpacing: 1, lineBreak: false });
  doc.font("mono").fontSize(7);
  const seatLabel = `SEAT ${seat}`;
  const sw = doc.widthOfString(seatLabel, { characterSpacing: 1 });
  doc.rect(W - m - 20 - sw, m - 6, sw + 10, 12).fill("#ffffff");
  doc.fillColor(grey).text(seatLabel, W - m - 15 - sw, m - 3, { characterSpacing: 1, lineBreak: false });

  let y = m + 16;
  doc.font("mono-bold").fontSize(9).fillColor("#111111").text(study.title.toUpperCase(), x, y, {
    width: inner,
    characterSpacing: 0.5,
  });
  y = doc.y + 10;
  doc.font("mono").fontSize(7).fillColor(grey).text("YOUR PARTICIPANT CODE", x, y, { characterSpacing: 1.2 });
  y = doc.y + 4;
  // the code in a dashed box
  doc.font("mono-bold").fontSize(20);
  const code = s.participantCode;
  const cw = doc.widthOfString(code, { characterSpacing: 2 });
  doc
    .dash(3, { space: 2 })
    .strokeColor("#111111")
    .rect(x, y, cw + 20, 34)
    .stroke()
    .undash();
  doc.fillColor("#111111").text(code, x + 10, y + 8, { characterSpacing: 2, lineBreak: false });
  y += 34 + 10;
  doc
    .font("mono")
    .fontSize(7.5)
    .fillColor("#111111")
    .text(study.takedownInstructions, x, y, { width: inner, lineGap: 1.5 });
  y = doc.y + 8;
  doc
    .font("mono-bold")
    .fontSize(7.5)
    .text("[ CONTACT ] ", x, y, { continued: true })
    .font("mono")
    .text(`${study.researcher} — ${study.contactEmail}`, { width: inner });
  doc
    .font("mono")
    .fontSize(6.5)
    .fillColor(grey)
    .text(`session ${sessionId} · ${row.created_wall.slice(0, 10)} · keep this card`, x, H - m - 14, {
      width: inner,
      lineBreak: false,
    });
  doc.end();
  return new Promise((resolve, reject) => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });
}
