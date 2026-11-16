import { z } from "zod";

/* A scenario = one map outline (regions) + N views (per-player datasets on that outline). */

export const RegionContentSchema = z
  .object({
    fill: z.string().optional().describe("CSS colour used to fill the region in this view"),
    label: z.string().optional().describe("Short text drawn on the region"),
    icon: z.string().optional().describe("Optional emoji/glyph drawn on the region"),
    attributes: z
      .record(z.string(), z.union([z.string(), z.number()]))
      .default({})
      .describe("Key/value data shown in the region info panel"),
    notes: z.string().optional().describe("Longer free text shown in the info panel"),
  })
  .describe("What one view shows for one region");
export type RegionContent = z.infer<typeof RegionContentSchema>;

export const ViewSchema = z.object({
  name: z.string().describe("Name of the view (may be shown to the player)"),
  description: z.string().default(""),
  regions: z.record(z.string(), RegionContentSchema).describe("Content per region id"),
});
export type View = z.infer<typeof ViewSchema>;

export const AttributeDefSchema = z.object({
  key: z.string(),
  label: z.string(),
  unit: z.string().default(""),
});
export type AttributeDef = z.infer<typeof AttributeDefSchema>;

/** scenario.json on disk. `map` points to an SVG file, `views` to a JSON file (or inline object). */
export const ScenarioFileSchema = z.object({
  id: z.string().regex(/^[a-z0-9-_]+$/),
  title: z.string(),
  version: z.string(),
  description: z.string().default(""),
  map: z.string().describe("Path (relative to scenario.json) of the SVG outline"),
  attributes: z.array(AttributeDefSchema).default([]),
  views: z.union([z.string(), z.record(z.string(), ViewSchema)]),
});
export type ScenarioFile = z.infer<typeof ScenarioFileSchema>;

export const RegionSchema = z.object({
  id: z.string().describe("Region id (from the SVG element id)"),
  name: z.string().describe("Human-readable region name (SVG data-name, or the id)"),
  path: z.string().describe("SVG path data"),
  anchor: z.tuple([z.number(), z.number()]).describe("Point used for labels/badges"),
});
export type Region = z.infer<typeof RegionSchema>;

/** A fully loaded scenario, as held by the server. */
export const ScenarioSchema = z.object({
  id: z.string(),
  title: z.string(),
  version: z.string(),
  description: z.string(),
  viewBox: z.string(),
  regions: z.array(RegionSchema),
  attributes: z.array(AttributeDefSchema),
  views: z.record(z.string(), ViewSchema),
  hash: z.string().describe("SHA-256 of the loaded scenario (for reproducibility)"),
});
export type Scenario = z.infer<typeof ScenarioSchema>;

/** Geometry the client needs to draw the outline (identical for every player). */
export type MapGeometry = Pick<Scenario, "viewBox" | "regions" | "attributes">;

/* ─────────────────────────── Geometry helpers ─────────────────────────── */

/**
 * Extract the vertex list of an SVG path (end points of every segment).
 * Good enough for computing label anchors; curves are approximated by
 * their end points.
 */
export function pathVertices(d: string): Array<[number, number]> {
  const tokens = d.match(/[a-zA-Z]|-?\d*\.?\d+(?:e[-+]?\d+)?/g) ?? [];
  const pts: Array<[number, number]> = [];
  let i = 0;
  let cmd = "";
  let x = 0;
  let y = 0;
  let startX = 0;
  let startY = 0;
  const num = () => Number(tokens[i++]);
  const argCount: Record<string, number> = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7, Z: 0 };
  while (i < tokens.length) {
    const t = tokens[i]!;
    if (/[a-zA-Z]/.test(t)) {
      cmd = t;
      i++;
      if (cmd === "Z" || cmd === "z") {
        x = startX;
        y = startY;
        continue;
      }
    }
    const up = cmd.toUpperCase();
    const rel = cmd !== up;
    const n = argCount[up];
    if (n === undefined || n === 0) {
      i++;
      continue;
    }
    const args: number[] = [];
    for (let k = 0; k < n; k++) args.push(num());
    if (args.some((a) => Number.isNaN(a))) break;
    let nx = x;
    let ny = y;
    if (up === "H") nx = rel ? x + args[0]! : args[0]!;
    else if (up === "V") ny = rel ? y + args[0]! : args[0]!;
    else {
      const ex = args[n - 2]!;
      const ey = args[n - 1]!;
      nx = rel ? x + ex : ex;
      ny = rel ? y + ey : ey;
    }
    x = nx;
    y = ny;
    if (up === "M") {
      startX = x;
      startY = y;
      cmd = rel ? "l" : "L"; // subsequent pairs are implicit line-to
    }
    pts.push([x, y]);
  }
  return pts;
}

/** Area-weighted polygon centroid; falls back to the bounding-box centre. */
export function pathAnchor(d: string): [number, number] {
  const pts = pathVertices(d);
  if (pts.length === 0) return [0, 0];
  let a = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x0, y0] = pts[i]!;
    const [x1, y1] = pts[(i + 1) % pts.length]!;
    const cross = x0 * y1 - x1 * y0;
    a += cross;
    cx += (x0 + x1) * cross;
    cy += (y0 + y1) * cross;
  }
  if (Math.abs(a) < 1e-6) {
    const xs = pts.map((p) => p[0]);
    const ys = pts.map((p) => p[1]);
    return [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2];
  }
  a *= 0.5;
  return [round1(cx / (6 * a)), round1(cy / (6 * a))];
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
