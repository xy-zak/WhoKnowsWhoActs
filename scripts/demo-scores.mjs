/**
 * Generates the starting scores of the demo scenarios (scenarios/<id>/scores.json):
 * a smooth, fixed-seed pattern of 0–10 per knowledge type, so each demo map is
 * varied but always the same.
 *
 *   demo        10 × 10 squares (400 sub-squares)
 *   demo-small   5 × 5 squares (100 sub-squares)
 *
 * Run: node scripts/demo-scores.mjs
 */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCENARIOS = [
  { id: "demo", cols: 10, rows: 10, seed: 20261117 },
  { id: "demo-small", cols: 5, rows: 5, seed: 7 },
];

/** mulberry32: small seeded PRNG */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Value noise: random 0–10 on a coarse lattice, bilinear in between, plus a little jitter. */
function matrix(random, COLS, ROWS) {
  const N = Math.min(4, Math.max(2, Math.ceil(Math.max(COLS, ROWS) / 3)));
  const lattice = Array.from({ length: N }, () => Array.from({ length: N }, () => random() * 10));
  const out = [];
  for (let r = 0; r < ROWS; r++) {
    const row = [];
    for (let c = 0; c < COLS; c++) {
      const y = (r / (ROWS - 1)) * (N - 1);
      const x = (c / (COLS - 1)) * (N - 1);
      const y0 = Math.min(N - 2, Math.floor(y));
      const x0 = Math.min(N - 2, Math.floor(x));
      const fy = y - y0;
      const fx = x - x0;
      const top = lattice[y0][x0] * (1 - fx) + lattice[y0][x0 + 1] * fx;
      const bottom = lattice[y0 + 1][x0] * (1 - fx) + lattice[y0 + 1][x0 + 1] * fx;
      const v = top * (1 - fy) + bottom * fy + (random() - 0.5) * 2.5;
      row.push(Math.max(0, Math.min(10, Math.round(v))));
    }
    out.push(row);
  }
  return out;
}

for (const sc of SCENARIOS) {
  const random = rng(sc.seed);
  const scores = Object.fromEntries(
    ["Ka", "Kb", "Kc", "Kd"].map((k) => [k, matrix(random, sc.cols, sc.rows)]),
  );
  const file = join(dirname(fileURLToPath(import.meta.url)), "..", "scenarios", sc.id, "scores.json");
  const json = `{\n${Object.entries(scores)
    .map(([k, m]) => `  "${k}": [\n${m.map((row) => `    [${row.join(", ")}]`).join(",\n")}\n  ]`)
    .join(",\n")}\n}\n`;
  writeFileSync(file, json);
  const all = Object.values(scores).flat(2);
  console.log(
    `Wrote ${file}: ${all.length} scores, mean ${(all.reduce((a, b) => a + b, 0) / all.length).toFixed(2)}`,
  );
}
