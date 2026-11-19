import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { type Browser, expect, type Locator, type Page, test } from "@playwright/test";
import { allShots, type ScenarioName, type ShotId, scenarioOf, shotById } from "./catalogue";
import { IMG_DIR, latest, readManifest, STAGING_DIR } from "./manifest";

/**
 * Screenshot capture: full-screen shots and crops of the real UI, with the
 * noise taken out (no toasts, no stray tooltips or hover, top of the page).
 *
 * Two layers:
 * - snap() / snapCrop(): write a PNG to any path. Reusable from any Playwright
 *   spec, e.g. for a one-off picture in a bug report.
 * - shot() / crop(): the same for a catalogued shot (e2e/screenshots/catalogue.ts).
 *   They write to the staging folder (.screenshots/<side>/<name>.png) and only
 *   when the shot was asked for (WKWA_SHOTS); `npm run screenshots -- publish`
 *   then files it as a new version in docs/img.
 *
 * Environment (set by scripts/screenshots.ts):
 *   WKWA_SHOTS      comma-separated shot ids to take (empty = all)
 *   WKWA_SHOTS_OUT  staging folder (default .screenshots/)
 */

/** Full screen: a common 1080p monitor, one image pixel per CSS pixel. */
export const SCREEN = { width: 1920, height: 1080 };
export const CONTEXT = {
  viewport: SCREEN,
  deviceScaleFactor: 1,
  colorScheme: "light",
  reducedMotion: "reduce",
} as const;

const OUT = process.env.WKWA_SHOTS_OUT ? path.resolve(process.env.WKWA_SHOTS_OUT) : STAGING_DIR;
const ONLY = new Set(
  (process.env.WKWA_SHOTS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
);
export const wanted = (id: string) => ONLY.size === 0 || ONLY.has(id);

/* ─────────────────────────── capture primitives ─────────────────────────── */

/** Toasts never appear; tooltips and fixed bars only when a capture asks for them. */
const SHOT_CSS = `
  .toasts { display: none !important; }
  html.shot-no-tip .tooltip { display: none !important; }
  html.shot-crop .statusbar, html.shot-crop .display-menu { visibility: hidden !important; }
`;

/** Call once per browser context, before the first goto. */
export async function prime(page: Page) {
  await page.context().addInitScript((css: string) => {
    const add = () => {
      const s = document.createElement("style");
      s.textContent = css;
      document.head.appendChild(s);
    };
    if (document.head) add();
    else document.addEventListener("DOMContentLoaded", add);
  }, SHOT_CSS);
}

export interface ShotOpts {
  /** Show the tooltip under the pointer (default: hidden). */
  tip?: boolean;
  /** Leave the pointer where it is (default: moved to the top edge, so nothing is hovered). */
  keepMouse?: boolean;
  /** Keep the fixed status bar and DISPLAY button in a crop (default: hidden). */
  fixed?: boolean;
  /** Extra wait before the capture, e.g. after a theme change. */
  wait?: number;
  /** Margin around a crop, in px. */
  pad?: number;
  /** Full shot: keep the current scroll position (default: scrolled to the top). */
  keepScroll?: boolean;
}

async function settle(page: Page, o: ShotOpts) {
  if (!o.keepMouse) await page.mouse.move(SCREEN.width / 2, 1);
  await page.evaluate(
    (tip) => document.documentElement.classList.toggle("shot-no-tip", !tip),
    Boolean(o.tip),
  );
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  await page.waitForTimeout(o.wait ?? 400);
}

async function done(page: Page) {
  await page.evaluate(() => document.documentElement.classList.remove("shot-no-tip", "shot-crop"));
}

/** Show tooltips again (they are hidden after every capture), e.g. before checking one is visible. */
export const showTips = (page: Page) =>
  page.evaluate(() => document.documentElement.classList.remove("shot-no-tip"));

/**
 * Hover an element until its tooltip (data-tip) shows. Scrolls first and lets
 * the scroll settle: the tooltip layer hides on every scroll.
 */
export async function hoverTip(page: Page, target: Locator) {
  await target.scrollIntoViewIfNeeded();
  await page.mouse.move(SCREEN.width / 2, 1);
  await page.waitForTimeout(150);
  await target.hover({ force: true });
  await showTips(page);
  await expect(page.locator(".tooltip")).toBeVisible();
}

/** The whole screen, as the person in front of it sees it. */
export async function snap(page: Page, file: string, o: ShotOpts = {}) {
  mkdirSync(path.dirname(file), { recursive: true });
  if (!o.keepScroll) await page.evaluate(() => window.scrollTo(0, 0));
  await settle(page, o);
  await page.screenshot({ path: file });
  await done(page);
}

/** Only the given part(s) of the screen, with a small margin. */
export async function snapCrop(page: Page, file: string, targets: Locator | Locator[], o: ShotOpts = {}) {
  mkdirSync(path.dirname(file), { recursive: true });
  const list = Array.isArray(targets) ? targets : [targets];
  await list[0]!.scrollIntoViewIfNeeded();
  await page.evaluate(
    (fixed) => document.documentElement.classList.toggle("shot-crop", !fixed),
    Boolean(o.fixed),
  );
  await settle(page, o);
  const boxes = [];
  for (const t of list) {
    const b = await t.boundingBox();
    if (b) boxes.push(b);
  }
  if (boxes.length === 0) throw new Error(`crop ${file}: nothing visible`);
  const pad = o.pad ?? 12;
  const x0 = Math.max(0, Math.min(...boxes.map((b) => b.x)) - pad);
  const x1 = Math.min(SCREEN.width, Math.max(...boxes.map((b) => b.x + b.width)) + pad);
  const y0 = Math.min(...boxes.map((b) => b.y)) - pad;
  const y1 = Math.max(...boxes.map((b) => b.y + b.height)) + pad;
  if (y0 >= 0 && y1 <= SCREEN.height) {
    await page.screenshot({ path: file, clip: { x: x0, y: y0, width: x1 - x0, height: y1 - y0 } });
  } else {
    // taller than the screen: capture the full page, in page coordinates
    const sy = await page.evaluate(() => window.scrollY);
    const top = Math.max(0, y0 + sy);
    await page.screenshot({
      path: file,
      fullPage: true,
      clip: { x: x0, y: top, width: x1 - x0, height: y1 + sy - top },
    });
  }
  await done(page);
}

/* ─────────────────────────── catalogued shots ─────────────────────────── */

let running: ScenarioName | null = null;
const captured: string[] = [];

/** Staging path of a catalogued shot, or null when it was not asked for. */
function target(id: ShotId): string | null {
  const def = shotById(id);
  if (!def) throw new Error(`unknown shot "${id}": add it to e2e/screenshots/catalogue.ts`);
  if (scenarioOf(def) !== running)
    throw new Error(`shot "${id}" is catalogued for scenario "${scenarioOf(def)}" but taken in "${running}"`);
  if (!wanted(id)) return null;
  if (!captured.includes(id)) captured.push(id); // a retried capture is reported once
  return path.join(OUT, `${id}.png`);
}

/** A catalogued full-screen shot. */
export async function shot(page: Page, id: ShotId, o: ShotOpts = {}) {
  const file = target(id);
  if (file) await snap(page, file, o);
}

/** A catalogued crop. */
export async function crop(page: Page, id: ShotId, targets: Locator | Locator[], o: ShotOpts = {}) {
  const file = target(id);
  if (file) await snapCrop(page, file, targets, o);
}

/**
 * One scenario: a test that plays a session through the UI and takes the
 * shots catalogued for it. Skipped when none of them is asked for. The page
 * passed in is the facilitator's, already primed.
 */
export function scenario(
  name: ScenarioName,
  title: string,
  body: (fx: { page: Page; browser: Browser }) => Promise<void>,
) {
  test(title, async ({ page, browser }) => {
    const ids = allShots.filter((s) => scenarioOf(s) === name).map((s) => s.id);
    test.skip(!ids.some(wanted), `no requested shot is taken in scenario "${name}"`);
    running = name;
    page.on("pageerror", (e) => console.log(`[${name}] facilitator page error:`, e.message));
    await prime(page);
    try {
      await body({ page, browser });
    } finally {
      running = null;
    }
  });
}

/* ─────────────────────────── report: staged vs latest published ─────────────────────────── */

interface Comparison {
  sameSize: boolean;
  size: [number, number];
  previousSize: [number, number];
  /** Share of pixels that differ, in %. Clocks, session ids and codes always differ a little. */
  changedPercent: number;
  /** Bounding box of the changed pixels: x, y, width, height. */
  box: [number, number, number, number] | null;
  /** Red = changed, on a faded copy of the new capture. */
  diff: string | null;
}

/** Pixel comparison in the browser (canvas), so no image library is needed. */
async function compare(
  page: Page,
  nowFile: string,
  beforeFile: string,
  diffFile: string,
): Promise<Comparison> {
  const url = (f: string) => `data:image/png;base64,${readFileSync(f).toString("base64")}`;
  const r = await page.evaluate(
    async ({ a, b }) => {
      const load = (src: string) =>
        new Promise<HTMLImageElement>((res, rej) => {
          const i = new Image();
          i.onload = () => res(i);
          i.onerror = rej;
          i.src = src;
        });
      const [now, before] = await Promise.all([load(a), load(b)]);
      const size: [number, number] = [now.width, now.height];
      const previousSize: [number, number] = [before.width, before.height];
      if (now.width !== before.width || now.height !== before.height)
        return { sameSize: false, size, previousSize, changedPercent: 100, box: null, png: null };
      const w = now.width;
      const h = now.height;
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d")!;
      ctx.drawImage(before, 0, 0);
      const old = ctx.getImageData(0, 0, w, h).data;
      ctx.clearRect(0, 0, w, h);
      ctx.drawImage(now, 0, 0);
      const image = ctx.getImageData(0, 0, w, h);
      const px = image.data;
      let changed = 0;
      let x0 = w;
      let y0 = h;
      let x1 = -1;
      let y1 = -1;
      for (let i = 0; i < px.length; i += 4) {
        const d =
          Math.abs(px[i]! - old[i]!) +
          Math.abs(px[i + 1]! - old[i + 1]!) +
          Math.abs(px[i + 2]! - old[i + 2]!);
        if (d > 48) {
          const p = i / 4;
          const x = p % w;
          const y = (p - x) / w;
          changed++;
          x0 = Math.min(x0, x);
          y0 = Math.min(y0, y);
          x1 = Math.max(x1, x);
          y1 = Math.max(y1, y);
          px[i] = 230;
          px[i + 1] = 0;
          px[i + 2] = 0;
        } else {
          const g = 255 - (255 - (px[i]! + px[i + 1]! + px[i + 2]!) / 3) * 0.3;
          px[i] = g;
          px[i + 1] = g;
          px[i + 2] = g;
        }
        px[i + 3] = 255;
      }
      ctx.putImageData(image, 0, 0);
      return {
        sameSize: true,
        size,
        previousSize,
        changedPercent: Math.round((changed / (w * h)) * 10000) / 100,
        box: changed ? ([x0, y0, x1 - x0 + 1, y1 - y0 + 1] as [number, number, number, number]) : null,
        png: changed ? canvas.toDataURL("image/png") : null,
      };
    },
    { a: url(nowFile), b: url(beforeFile) },
  );
  if (r.png) writeFileSync(diffFile, Buffer.from(r.png.split(",")[1]!, "base64"));
  const { png, ...rest } = r;
  return { ...rest, diff: png ? path.relative(process.cwd(), diffFile) : null };
}

/**
 * After all scenarios: compare every staged capture with the latest published
 * version and write .screenshots/report.json (read by `npm run screenshots -- capture`).
 */
export async function writeReport(browser: Browser) {
  if (captured.length === 0) return;
  const m = readManifest();
  const context = await browser.newContext();
  const page = await context.newPage();
  const shots: Record<string, unknown> = {};
  for (const id of captured) {
    const staged = path.join(OUT, `${id}.png`);
    const last = latest(m, id);
    const published = last ? path.join(IMG_DIR, last.file) : null;
    shots[id] = {
      staged: path.relative(process.cwd(), staged),
      latest: last ? { v: last.v, file: `docs/img/${last.file}`, date: last.date } : null,
      compare:
        published && existsSync(published)
          ? await compare(page, staged, published, path.join(OUT, `${id}.diff.png`))
          : null,
    };
  }
  await context.close();
  writeFileSync(path.join(OUT, "report.json"), `${JSON.stringify({ shots }, null, 2)}\n`);
}
