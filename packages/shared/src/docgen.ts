import { z } from "zod";
import { SessionConfigSchema } from "./config";
import { EVENT_DEFS, EVENT_TYPES, EventEnvelopeSchema, type EventType } from "./events";
import { EXPORT_FILES, type ExportFileDef, expandColumns } from "./exportColumns";
import { DEFAULT_GAME_RULES, GAME_RULES } from "./game/rules";
import { CROCKFORD, normaliseParticipantCode } from "./ids";
import { DISSOCIATED_PAIRINGS, K_LABELS, type LabelPairing, P_LABELS, pairedP, pairingPerm } from "./labels";
import type { DataClass, RecordMeta } from "./meta";
import { MESSAGES, type MessageDef } from "./protocol";
import { BUILT_IN_POLICIES } from "./simulation/policies";
import {
  TELEMETRY_DEFS,
  TELEMETRY_TYPES,
  TelemetryEnvelopeSchema,
  TelemetryItemSchema,
  type TelemetryType,
} from "./telemetry";

/* ═══════════════════════════════════════════════════════════════════════════
 * DOCUMENTATION GENERATOR — renders Markdown from the zod schemas and record
 * metadata. Used by scripts/generate-docs.ts (docs/*.md) and by the server's
 * exporter (codebook.md). Pure functions: no file system access.
 * ═══════════════════════════════════════════════════════════════════════════ */

// biome-ignore lint/suspicious/noExplicitAny: JSON Schema is untyped
type JS = Record<string, any>;

const SAFE = 9007199254740991;

function toJS(schema: z.ZodType, io: "input" | "output" = "output"): JS {
  return z.toJSONSchema(schema, { io, unrepresentable: "any" }) as JS;
}

/* ─────────────────────────── Named sub-schemas ─────────────────────────── */

/** Objects recognised by their property set and rendered as a named type instead of being expanded. */
const NAMED_TYPES: Array<{ name: string; link: string; keys: string }> = [
  { name: "SessionConfig", link: "#session-configuration", keys: keySig(toJS(SessionConfigSchema)) },
  { name: "TelemetryItem", link: "#telemetry-types", keys: keySig(toJS(TelemetryItemSchema)) },
];

function keySig(js: JS): string {
  return Object.keys(js.properties ?? {})
    .sort()
    .join(",");
}

function namedType(js: JS): (typeof NAMED_TYPES)[number] | undefined {
  if (js.type !== "object" || !js.properties) return undefined;
  const sig = keySig(js);
  return NAMED_TYPES.find((n) => n.keys === sig);
}

/* ─────────────────────────── Type strings ─────────────────────────── */

function unwrapNullable(js: JS): { inner: JS; nullable: boolean } {
  if (Array.isArray(js.anyOf)) {
    const nonNull = js.anyOf.filter((m: JS) => m.type !== "null");
    if (nonNull.length === 1 && nonNull.length < js.anyOf.length) {
      return {
        inner: { ...nonNull[0], description: js.description ?? nonNull[0].description },
        nullable: true,
      };
    }
  }
  if (Array.isArray(js.type) && js.type.includes("null")) {
    const rest = js.type.filter((t: string) => t !== "null");
    return { inner: { ...js, type: rest.length === 1 ? rest[0] : rest }, nullable: true };
  }
  return { inner: js, nullable: false };
}

function describeOf(js: JS): string {
  if (js.description) return js.description;
  if (Array.isArray(js.anyOf)) {
    for (const m of js.anyOf) if (m.description) return m.description;
  }
  return "";
}

function range(js: JS): string {
  const lo = js.minimum ?? (js.exclusiveMinimum !== undefined ? `> ${js.exclusiveMinimum}` : undefined);
  const hi = js.maximum;
  const hasLo = lo !== undefined && lo !== -SAFE;
  const hasHi = hi !== undefined && hi !== SAFE;
  if (hasLo && hasHi) return ` ${lo}–${hi}`;
  if (hasLo) return typeof lo === "string" ? ` ${lo}` : ` ≥ ${lo}`;
  if (hasHi) return ` ≤ ${hi}`;
  return "";
}

/** Short human-readable type, e.g. `integer 1–4`, `"start" | "end"`, `map<string, boolean>`. */
export function typeString(js: JS, compactObjects = false, depth = 0): string {
  const { inner, nullable } = unwrapNullable(js);
  const base = typeStringInner(inner, compactObjects, depth);
  return nullable ? `${base} | null` : base;
}

function typeStringInner(js: JS, compactObjects: boolean, depth: number): string {
  const named = namedType(js);
  if (named) return named.name;
  if (js.enum) return js.enum.map((v: unknown) => JSON.stringify(v)).join(" | ");
  if (js.const !== undefined) return JSON.stringify(js.const);
  if (Array.isArray(js.anyOf))
    return js.anyOf.map((m: JS) => typeString(m, compactObjects, depth)).join(" | ");
  if (js.type === undefined && js.format === "binary") return "binary";
  const t = Array.isArray(js.type) ? js.type.join(" | ") : js.type;
  switch (t) {
    case "integer":
      return `integer${range(js)}`;
    case "number":
      return `number${range(js)}`;
    case "string": {
      if (js.format === "uuid") return "string (uuid)";
      const extra: string[] = [];
      if (js.maxLength !== undefined) extra.push(`≤ ${js.maxLength} chars`);
      if (js.pattern) extra.push("pattern");
      return extra.length ? `string (${extra.join(", ")})` : "string";
    }
    case "boolean":
      return "boolean";
    case "array":
      return `array<${js.items ? typeString(js.items, compactObjects, depth + 1) : "any"}>`;
    case "object": {
      if (js.properties && Object.keys(js.properties).length > 0) {
        if (!compactObjects || depth > 2) return "object";
        const req: string[] = js.required ?? [];
        const parts = Object.entries(js.properties as Record<string, JS>).map(
          ([k, v]) => `${k}${req.includes(k) ? "" : "?"}: ${typeString(v, true, depth + 1)}`,
        );
        return `{ ${parts.join(", ")} }`;
      }
      if (js.additionalProperties && typeof js.additionalProperties === "object") {
        const v = js.additionalProperties as JS;
        if (Object.keys(v).length === 0) return depth === 0 && compactObjects ? "{}" : "object";
        return `map<string, ${typeString(v, true, depth + 1)}>`;
      }
      return "{}";
    }
    case undefined:
      return "any";
    default:
      return String(t);
  }
}

/* ─────────────────────────── Field flattening ─────────────────────────── */

export interface FieldRow {
  name: string;
  type: string;
  required: boolean;
  description: string;
  defaultValue?: unknown;
}

/** Flatten an object schema into rows; nested objects become dotted names (`a.b`), arrays `a[].b`. */
export function flattenFields(js: JS, maxDepth = 3, prefix = "", depth = 0): FieldRow[] {
  const rows: FieldRow[] = [];
  const props = (js.properties ?? {}) as Record<string, JS>;
  const required: string[] = js.required ?? [];
  for (const [key, sub] of Object.entries(props)) {
    const name = `${prefix}${key}`;
    const description = describeOf(sub);
    const { inner, nullable } = unwrapNullable(sub);
    const row: FieldRow = {
      name,
      type: typeString(sub),
      required: required.includes(key),
      description,
      defaultValue: sub.default,
    };
    const expandable = !namedType(inner) && inner.type === "object" && inner.properties;
    const arrayOfObjects =
      inner.type === "array" &&
      inner.items?.type === "object" &&
      inner.items.properties &&
      !namedType(inner.items);
    if (expandable && depth + 1 < maxDepth) {
      row.type = nullable ? "object | null" : "object";
      rows.push(row);
      rows.push(...flattenFields(inner, maxDepth, `${name}.`, depth + 1));
    } else if (arrayOfObjects && depth + 1 < maxDepth) {
      row.type = "array<object>";
      if (!row.description && inner.items.description) row.description = inner.items.description;
      rows.push(row);
      rows.push(...flattenFields(inner.items, maxDepth, `${name}[].`, depth + 1));
    } else {
      rows.push(row);
    }
  }
  return rows;
}

/* ─────────────────────────── Markdown helpers ─────────────────────────── */

export function cell(s: unknown): string {
  return String(s ?? "")
    .replace(/\|/g, "\\|")
    .replace(/\r?\n/g, " ");
}

function code(s: string): string {
  return `\`${s}\``;
}

export function table(headers: string[], rows: string[][]): string {
  const head = `| ${headers.join(" | ")} |`;
  const sep = `| ${headers.map(() => "---").join(" | ")} |`;
  const body = rows.map((r) => `| ${r.map(cell).join(" | ")} |`);
  return [head, sep, ...body].join("\n");
}

function fieldTable(rows: FieldRow[]): string {
  if (rows.length === 0) return "_No payload fields._";
  return table(
    ["Field", "Type", "Description"],
    rows.map((r) => [code(r.name), code(r.type), r.description || "—"]),
  );
}

function camelToSnake(s: string): string {
  return s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}

/** GitHub heading anchor of "### `Name`". */
export function anchorOf(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9_ -]/g, "")
    .replace(/ /g, "-");
}

const DATA_CLASS_LABEL: Record<DataClass, string> = {
  "non-personal": "non-personal",
  pseudonymous: "pseudonymous",
  "pseudonymous-sensitive": "pseudonymous · sensitive",
  voice: "voice · identifying",
};

/* ─────────────────────────── Examples ─────────────────────────── */

/** A syntactically valid example participant code (check character computed). */
export const EXAMPLE_CODE: string = (() => {
  for (const ch of CROCKFORD) {
    const c = normaliseParticipantCode(`WK-7F3K-Q9XM-${ch}`);
    if (c) return c;
  }
  return "WK-7F3K-Q9XM-?";
})();

const EXAMPLE_SESSION = "S-20261116-7KQ2";
const EXAMPLE_TS = 1794826000000; // 2026-11-16T10:46:40Z

const IN_ROUND: ReadonlySet<EventType> = new Set([
  "ProposalMade",
  "DecisionMade",
  "IntentRejected",
  "ActionRevoked",
  "GamePaused",
  "GameResumed",
  "RecordingPaused",
  "RecordingResumed",
  "AudioTrackStopped",
  "FacilitatorBroadcast",
]);
const WITH_CLIENT_SEQ: ReadonlySet<EventType> = new Set(["ProposalMade", "DecisionMade", "IntentRejected"]);

export function exampleEventRow(type: EventType, seq = 42): Record<string, unknown> {
  const def = EVENT_DEFS[type] as RecordMeta;
  const payload = def.example as Record<string, unknown>;
  // Per-seat events carry seat + participant code in the envelope (so erasure finds them);
  // session-level events (e.g. LabelsAssigned, RoundStarted) carry neither.
  const payloadSeat =
    typeof payload.seat === "number"
      ? payload.seat
      : typeof payload.targetSeat === "number"
        ? payload.targetSeat
        : undefined;
  const fromPlayer = def.actors.includes("player");
  const seat = payloadSeat ?? (fromPlayer ? 2 : null);
  const personal = seat !== null && def.dataClass !== "non-personal";
  const round =
    typeof payload.round === "number"
      ? payload.round
      : type === "GameCompleted"
        ? 3
        : IN_ROUND.has(type)
          ? 1
          : 0;
  return {
    sessionId: EXAMPLE_SESSION,
    seq,
    type,
    actorKind: def.actors[0],
    seat,
    participantCode: personal ? EXAMPLE_CODE : null,
    round,
    serverTs: EXAMPLE_TS + 0.512,
    serverWall: new Date(EXAMPLE_TS).toISOString(),
    clientTs: fromPlayer ? EXAMPLE_TS - 4.2 : null,
    clientSeq: WITH_CLIENT_SEQ.has(type) ? 7 : null,
    payload,
  };
}

export function exampleTelemetryRow(type: TelemetryType, id = 1234): Record<string, unknown> {
  const def = TELEMETRY_DEFS[type] as RecordMeta;
  return {
    id,
    sessionId: EXAMPLE_SESSION,
    seat: 2,
    participantCode: EXAMPLE_CODE,
    round: 1,
    type,
    clientTs: EXAMPLE_TS - 1200.4,
    clientOffsetMs: -12.4,
    serverTs: EXAMPLE_TS + 0.9,
    serverWall: new Date(EXAMPLE_TS).toISOString(),
    payload: def.example,
  };
}

/* ─────────────────────────── Envelopes ─────────────────────────── */

function envelopeTable(schema: z.ZodType, extra: Array<[string, string, string, string]>): string {
  const rows = flattenFields(toJS(schema), 1).map((r) => [
    code(camelToSnake(r.name)),
    code(r.name),
    code(r.type),
    r.description,
  ]);
  return table(
    ["SQLite column", "JSON field", "Type", "Description"],
    [...rows, ...extra.map((e) => [...e])],
  );
}

export function renderEnvelopeTable(): string {
  return envelopeTable(EventEnvelopeSchema, [
    ["`payload_json`", "`payload`", "`object`", "Type-specific payload (see the event sections below)"],
  ]);
}

export function renderTelemetryEnvelopeTable(): string {
  return envelopeTable(TelemetryEnvelopeSchema, [
    ["`payload_json`", "`payload`", "`object`", "Type-specific payload (see the telemetry sections below)"],
  ]);
}

/* ─────────────────────────── Record sections ─────────────────────────── */

function recordIndex(names: readonly string[], defs: Record<string, RecordMeta>): string {
  return table(
    ["Type", "Summary", "Caused by", "Changes state", "Data class", "Typical frequency"],
    names.map((n) => {
      const d = defs[n]!;
      return [
        `[${code(n)}](#${anchorOf(n)})`,
        d.summary,
        d.actors.join(", "),
        d.changesState ? "yes" : "no",
        DATA_CLASS_LABEL[d.dataClass],
        d.frequency,
      ];
    }),
  );
}

function recordSection(
  name: string,
  d: RecordMeta,
  example: Record<string, unknown>,
  heading = "###",
): string {
  const facts = table(
    ["", ""],
    [
      ["**Trigger**", d.trigger],
      ["**Caused by**", d.actors.join(", ")],
      ["**Changes game state**", d.changesState ? "yes" : "no"],
      ["**Visible to**", d.visibleTo],
      ["**Data class**", DATA_CLASS_LABEL[d.dataClass]],
      ["**Typical frequency**", d.frequency],
    ],
  );
  return [
    `${heading} ${code(name)}`,
    "",
    d.summary,
    "",
    facts,
    "",
    "**Payload**",
    "",
    fieldTable(flattenFields(toJS(d.payload))),
    "",
    "<details><summary>Example row</summary>",
    "",
    "```json",
    JSON.stringify(example, null, 2),
    "```",
    "",
    "</details>",
  ].join("\n");
}

export function renderEventIndex(): string {
  return recordIndex(EVENT_TYPES, EVENT_DEFS as unknown as Record<string, RecordMeta>);
}

export function renderEventSections(): string {
  return EVENT_TYPES.map((t) =>
    recordSection(t, EVENT_DEFS[t] as unknown as RecordMeta, exampleEventRow(t)),
  ).join("\n\n");
}

export function renderTelemetryIndex(): string {
  return recordIndex(TELEMETRY_TYPES, TELEMETRY_DEFS as unknown as Record<string, RecordMeta>);
}

export function renderTelemetrySections(): string {
  return TELEMETRY_TYPES.map((t) =>
    recordSection(t, TELEMETRY_DEFS[t] as unknown as RecordMeta, exampleTelemetryRow(t)),
  ).join("\n\n");
}

/** Record types grouped by personal-data class (used in DATA-MANAGEMENT.md). */
export function renderDataClassSummary(): string {
  const classes: DataClass[] = ["voice", "pseudonymous-sensitive", "pseudonymous", "non-personal"];
  const rows = classes.map((c) => {
    const ev = EVENT_TYPES.filter((t) => (EVENT_DEFS[t] as RecordMeta).dataClass === c).map(code);
    const tel = TELEMETRY_TYPES.filter((t) => (TELEMETRY_DEFS[t] as RecordMeta).dataClass === c).map(code);
    return [DATA_CLASS_LABEL[c], ev.join(", ") || "—", tel.join(", ") || "—"];
  });
  return [
    table(["Data class", "Game events", "Telemetry types"], rows),
    "",
    `${DATA_CLASS_LABEL.voice}: recordings of a participant's voice. No event or telemetry payload carries voice: the audio is stored as encrypted files (${code("data/audio/<sessionId>/*.wka")}, one key per file in the database) and is never part of an anonymised export.`,
  ].join("\n");
}

/* ─────────────────────────── Session configuration ─────────────────────────── */

export function renderConfigTable(): string {
  const rows = flattenFields(toJS(SessionConfigSchema, "input"), 4);
  return table(
    ["Setting", "Type", "Default", "Description"],
    rows.map((r) => [
      code(r.name),
      code(r.type),
      r.defaultValue === undefined || (typeof r.defaultValue === "object" && r.defaultValue !== null)
        ? "—"
        : code(JSON.stringify(r.defaultValue)),
      r.description || "—",
    ]),
  );
}

/* ─────────────────────────── Simulated players ─────────────────────────── */

/** Parameter rows of an agent policy (name, type, default, description), for docs and the setup screen. */
export function policyParamRows(policy: { params: z.ZodType }): FieldRow[] {
  return flattenFields(toJS(policy.params, "input"), 2);
}

/** The built-in agent policies and their parameters (`simulation.params.<id>`). */
export function renderSimulationPolicies(): string {
  const out: string[] = [
    table(
      ["Policy", "Version", "Name", "What it does"],
      BUILT_IN_POLICIES.map((p) => [code(p.id), p.version, p.name, p.description]),
    ),
  ];
  for (const p of BUILT_IN_POLICIES) {
    const rows = policyParamRows(p);
    out.push(
      "",
      `**${code(p.id)} parameters** (${code(`simulation.params.${p.id}`)}):${rows.length ? "" : " none."}`,
    );
    if (rows.length) {
      out.push(
        "",
        table(
          ["Parameter", "Type", "Default", "Description"],
          rows.map((r) => [
            code(r.name),
            code(r.type),
            r.defaultValue === undefined ? "—" : code(JSON.stringify(r.defaultValue)),
            r.description || "—",
          ]),
        ),
      );
    }
  }
  return out.join("\n");
}

/* ─────────────────────────── Game rules ─────────────────────────── */

/** Every registered rule set (game/rules.ts) with its numbers, for GAME-RULES.md. */
export function renderGameRules(): string {
  const out: string[] = [
    table(
      ["Rules (`rules`)", "Version", "Name", "Score range", "What it does"],
      GAME_RULES.map((r) => [
        `${code(r.id)}${r.id === DEFAULT_GAME_RULES ? " (default)" : ""}`,
        r.version,
        r.name,
        `${r.scoreRange.min}–${r.scoreRange.max}`,
        r.summary,
      ]),
    ),
  ];
  for (const r of GAME_RULES) {
    out.push(
      "",
      `**${code(r.id)} numbers** (${code("packages/shared/src/game/rules.ts")}):`,
      "",
      table(
        ["Parameter", "Value"],
        Object.entries(r.params).map(([k, v]) => [k, code(typeof v === "string" ? v : JSON.stringify(v))]),
      ),
    );
  }
  return out.join("\n");
}

/* ─────────────────────────── Message catalogue ─────────────────────────── */

function messagePayload(m: MessageDef): string {
  if (typeof m.schema === "string") return m.schema;
  return typeString(toJS(m.schema, "input"), true);
}

export function renderMessageCatalogue(): string {
  const out: string[] = [];
  const groups: Array<[MessageDef["namespace"], MessageDef["direction"]]> = [
    ["/player", "client→server"],
    ["/player", "server→client"],
    ["/facilitator", "client→server"],
    ["/facilitator", "server→client"],
  ];
  for (const [ns, dir] of groups) {
    const entries = Object.entries(MESSAGES).filter(([, m]) => m.namespace === ns && m.direction === dir);
    out.push(`#### ${code(ns)} — ${dir}`, "");
    const withAck = dir === "client→server";
    out.push(
      table(
        withAck
          ? ["Message", "Payload", "Ack (callback)", "Logged as", "Description"]
          : ["Message", "Payload", "Logged as", "Description"],
        entries.map(([name, m]) =>
          withAck
            ? [
                code(name),
                code(messagePayload(m)),
                m.ack ? code(m.ack) : "— (no ack)",
                m.logged,
                m.description,
              ]
            : [code(name), code(messagePayload(m)), m.logged, m.description],
        ),
      ),
      "",
    );
  }
  return out.join("\n").trimEnd();
}

/* ─────────────────────────── Export columns ─────────────────────────── */

function exportFileSection(
  f: ExportFileDef,
  ids: { consentItems?: string[]; demographicQuestions?: string[] } | null,
  heading: string,
): string {
  const parts = [
    `${heading} ${code(f.file)}`,
    "",
    `${f.description} _Unit:_ ${f.rowUnit}. _Data class:_ ${DATA_CLASS_LABEL[f.dataClass]}.`,
    "",
  ];
  const cols = ids ? expandColumns(f, ids) : f.columns;
  if (cols.length > 0) {
    parts.push(
      table(
        [f.format === "csv" ? "Column" : "Key", "Type", "Description", "Source"],
        cols.map((c) => [code(c.name), c.type, c.description, c.source]),
      ),
    );
  }
  if (f.dynamicColumns && !ids) {
    const d = f.dynamicColumns;
    parts.push(
      "",
      `Plus one column ${code(d.pattern)} (${d.type}) per ${
        d.idsFrom === "consentItems"
          ? "consent item in `config/consent.json`"
          : "question in `config/demographics.json`"
      }: ${d.description}.`,
    );
  }
  return parts.join("\n");
}

export function renderExportColumns(): string {
  return EXPORT_FILES.map((f) => exportFileSection(f, null, "####")).join("\n\n");
}

/* ─────────────────────────── Codebook (per export) ─────────────────────────── */

export interface CodebookMeta {
  sessionId: string;
  exportId: string;
  kind: "standard" | "anonymised";
  createdWall: string;
  harness?: { version: string; gitCommit: string };
  scenario?: { id: string; title: string; version: string; hash: string };
  consentItems?: string[];
  demographicQuestions?: string[];
}

export function renderCodebook(meta: CodebookMeta): string {
  const header = table(
    ["", ""],
    [
      ["Session", code(meta.sessionId)],
      ["Export id", code(meta.exportId)],
      [
        "Kind",
        meta.kind === "anonymised"
          ? "anonymised — participant codes replaced by random A-XXXXXX ids; the mapping was discarded"
          : "standard — pseudonymised (participant codes present)",
      ],
      ["Created", meta.createdWall],
      ["Harness", meta.harness ? `${meta.harness.version} (${meta.harness.gitCommit})` : "—"],
      [
        "Scenario",
        meta.scenario
          ? `${meta.scenario.title} — ${meta.scenario.id} v${meta.scenario.version} (${meta.scenario.hash})`
          : "—",
      ],
    ],
  );
  const ids = {
    consentItems: meta.consentItems ?? [],
    demographicQuestions: meta.demographicQuestions ?? [],
  };
  const files = EXPORT_FILES.map((f) => exportFileSection(f, ids, "###")).join("\n\n");
  const payloads = (names: readonly string[], defs: Record<string, RecordMeta>) =>
    names
      .map((n) => {
        const d = defs[n]!;
        return [`### ${code(n)}`, "", d.summary, "", fieldTable(flattenFields(toJS(d.payload)))].join("\n");
      })
      .join("\n\n");
  return [
    `# Codebook — ${meta.sessionId}`,
    "",
    "Generated automatically by the *Who Knows, Who Acts?* harness from the same schemas that validate the data.",
    "",
    header,
    "",
    "## Conventions",
    "",
    "- CSV: UTF-8, comma-separated, RFC 4180 quoting, header row. Empty cell = null / not applicable.",
    "- Booleans are `0`/`1`. `*_ts` columns are Unix epoch milliseconds (may have decimals); `*_wall` columns are ISO-8601 UTC.",
    "- Client timestamps are corrected to the server clock (NTP-style offset estimate; see `telemetry` type `clock_sync`).",
    "- Seat lists are space-separated seat numbers, e.g. `1 3`.",
    "- `payload_json` columns contain the JSON payload documented under *Event payloads* / *Telemetry payloads*.",
    "",
    "## Files",
    "",
    files,
    "",
    "## Event payloads (`events.csv` → `payload_json`)",
    "",
    payloads(EVENT_TYPES, EVENT_DEFS as unknown as Record<string, RecordMeta>),
    "",
    "## Telemetry payloads (`telemetry.csv` → `payload_json`)",
    "",
    payloads(TELEMETRY_TYPES, TELEMETRY_DEFS as unknown as Record<string, RecordMeta>),
    "",
  ].join("\n");
}

/* ─────────────────────────── Generated blocks in docs/*.md ─────────────────────────── */

/** The K–P pairing table: aligned + the six fully dissociative pairings, as list and as 4×4 matrices. */
export function renderLabelPairings(): string {
  const all: Array<{ name: string; pairing: LabelPairing }> = [
    { name: "aligned", pairing: { mode: "aligned", id: null } },
    ...DISSOCIATED_PAIRINGS.map((_, i) => ({
      name: `D${i + 1}`,
      pairing: { mode: "dissociated" as const, id: i + 1 },
    })),
  ];
  const list = table(
    ["Pairing", "Stored as", ...K_LABELS.map((k) => `${k} →`), "Cycle"],
    all.map(({ name, pairing }) => {
      const perm = pairingPerm(pairing);
      let cycle = "—";
      if (pairing.mode === "dissociated") {
        const letters = "abcd";
        let i = 0;
        const path = [letters[0]];
        do {
          i = perm[i]!;
          path.push(letters[i]);
        } while (i !== 0);
        cycle = path.join("→");
      }
      return [
        `**${name}**`,
        code(JSON.stringify(pairing)),
        ...K_LABELS.map((k) => pairedP(k, pairing)),
        cycle,
      ];
    }),
  );
  const matrices = all
    .map(({ name, pairing }) =>
      [
        `**${name}**`,
        "",
        table(
          [name, ...P_LABELS],
          K_LABELS.map((k) => [k, ...P_LABELS.map((p) => (pairedP(k, pairing) === p ? "■" : "·"))]),
        ),
      ].join("\n"),
    )
    .join("\n\n");
  return [
    list,
    "",
    "Matrices (rows = knowledge type, columns = power type, ■ = held by the same seat):",
    "",
    matrices,
  ].join("\n");
}

export const GENERATED_BLOCKS: Record<string, () => string> = {
  "label-pairings": renderLabelPairings,
  "event-envelope": renderEnvelopeTable,
  "telemetry-envelope": renderTelemetryEnvelopeTable,
  "event-index": renderEventIndex,
  "event-sections": renderEventSections,
  "telemetry-index": renderTelemetryIndex,
  "telemetry-sections": renderTelemetrySections,
  "session-config": renderConfigTable,
  "export-columns": renderExportColumns,
  "message-catalogue": renderMessageCatalogue,
  "data-class-summary": renderDataClassSummary,
  "simulation-policies": renderSimulationPolicies,
  "game-rules": renderGameRules,
};

const BLOCK_RE = /<!-- BEGIN GENERATED: ([a-z0-9-]+) -->[\s\S]*?<!-- END GENERATED: \1 -->/g;

/**
 * Replace every `<!-- BEGIN GENERATED: name --> … <!-- END GENERATED: name -->`
 * block with freshly rendered content. Returns the new text plus the block
 * names used and any unknown names.
 */
export function applyGeneratedBlocks(
  markdown: string,
  blocks: Record<string, () => string> = GENERATED_BLOCKS,
): { content: string; used: string[]; unknown: string[] } {
  const used: string[] = [];
  const unknown: string[] = [];
  const content = markdown.replace(BLOCK_RE, (whole, name: string) => {
    const render = blocks[name];
    if (!render) {
      unknown.push(name);
      return whole;
    }
    used.push(name);
    return [
      `<!-- BEGIN GENERATED: ${name} -->`,
      "<!-- Generated by `npm run docs:generate` from packages/shared — do not edit by hand. -->",
      "",
      render().trim(),
      "",
      `<!-- END GENERATED: ${name} -->`,
    ].join("\n");
  });
  return { content, used, unknown };
}
