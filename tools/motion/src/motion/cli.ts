/**
 * Render every composition to a GIF.
 *
 * Pipeline: esbuild bundles the compositions into one self-contained page,
 * headless Chromium renders each frame deterministically and screenshots it,
 * then ffmpeg turns the PNG sequence into a GIF.
 *
 * The ffmpeg stage is two-pass on purpose. A naive single global palette
 * produced ~50 MB files for these clips; `stats_mode=diff` plus
 * `diff_mode=rectangle` gets the same clips under a megabyte, because almost
 * every pixel is static chrome and only changed rectangles need palette entries.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as esbuild from "esbuild";
import { chromium } from "playwright-core";

import { COMPOSITION_META as COMPOSITIONS } from "../compositions.meta.ts";

const HERE = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const ROOT = NodePath.resolve(HERE, "../..");
const OUT_DIR = NodePath.resolve(ROOT, "../../docs/media/readme");

/** README renders at 1100px; 1000 keeps files small at negligible visible cost. */
const GIF_WIDTH = 1000;
const GIF_FPS = 12;
const GIF_COLORS = 64;

/**
 * Same policy as the app's own browser VM provider: prefer Playwright's managed
 * Chromium when one is installed, then fall back to a system browser.
 */
const SYSTEM_BROWSER_CANDIDATES = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
];

function resolveBrowserExecutable(): string {
  try {
    const bundled = chromium.executablePath();
    if (bundled && NodeFS.existsSync(bundled)) return bundled;
  } catch {
    // Throws when no managed browser is registered; fall through to the system.
  }
  for (const candidate of SYSTEM_BROWSER_CANDIDATES) {
    if (NodeFS.existsSync(candidate)) return candidate;
  }
  throw new Error(
    "No Chromium-family browser found. Install Google Chrome, or run `npx playwright install chromium`.",
  );
}

function run(command: string, args: readonly string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = NodeChildProcess.spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited ${code}\n${stderr.trim()}`));
    });
  });
}

async function bundle(): Promise<string> {
  const result = await esbuild.build({
    entryPoints: [NodePath.join(HERE, "entry.tsx")],
    bundle: true,
    write: false,
    // Never written (write: false), but esbuild needs an output path configured
    // before it will emit the CSS import as a separate output file.
    outdir: "out",
    format: "iife",
    platform: "browser",
    jsx: "automatic",
    // Fonts resolve to data URLs so the page is one file with no late loads;
    // a font arriving mid-render would reflow the clip partway through.
    loader: { ".woff2": "dataurl", ".woff": "dataurl", ".ttf": "dataurl" },
    define: { "process.env.NODE_ENV": '"production"' },
    minify: true,
  });
  const js = result.outputFiles?.find((file) => file.path.endsWith(".js"))?.text ?? "";
  const css = result.outputFiles?.find((file) => file.path.endsWith(".css"))?.text ?? "";
  return `<!doctype html>
<html><head><meta charset="utf-8"><style>
html,body{margin:0;padding:0;background:#050505;overflow:hidden}
${css}
</style></head><body><div id="root"></div><script>${js}</script></body></html>`;
}

async function renderFrames(html: string, outDir: string): Promise<void> {
  const pagePath = NodePath.join(outDir, "page.html");
  NodeFS.writeFileSync(pagePath, html);

  const browser = await chromium.launch({
    executablePath: resolveBrowserExecutable(),
    args: ["--force-color-profile=srgb", "--font-render-hinting=none", "--hide-scrollbars"],
  });
  try {
    for (const composition of COMPOSITIONS) {
      process.stdout.write(`→ ${composition.id}\n`);
      const frameDir = NodePath.join(outDir, composition.id);
      NodeFS.mkdirSync(frameDir, { recursive: true });

      const page = await browser.newPage({
        viewport: { width: composition.width, height: composition.height },
        // 1.5 gives 1920x1200 for a 1000px GIF — still a comfortable downscale,
        // at roughly half the pixels (and peak memory) of a 2x capture.
        deviceScaleFactor: 1.5,
      });
      await page.goto(`file://${pagePath}?composition=${composition.id}`, {
        waitUntil: "load",
      });
      await page.evaluate(() => window.__motion.ready());

      for (let frame = 0; frame < composition.durationInFrames; frame += 1) {
        await page.evaluate((value) => {
          window.__motion.setFrame(value);
        }, frame);
        await page.screenshot({
          path: NodePath.join(frameDir, `${String(frame).padStart(5, "0")}.png`),
          animations: "disabled",
        });
      }
      await page.close();
    }
  } finally {
    await browser.close();
  }
}

async function encode(id: string, fps: number, frameDir: string, outDir: string): Promise<void> {
  const pattern = NodePath.join(frameDir, "%05d.png");
  const palette = NodePath.join(outDir, `${id}-palette.png`);
  const filters = `fps=${GIF_FPS},scale=${GIF_WIDTH}:-1:flags=lanczos`;

  await run("ffmpeg", [
    "-loglevel",
    "error",
    "-framerate",
    String(fps),
    "-i",
    pattern,
    "-vf",
    `${filters},palettegen=max_colors=${GIF_COLORS}:stats_mode=diff`,
    "-y",
    palette,
  ]);
  await run("ffmpeg", [
    "-loglevel",
    "error",
    "-framerate",
    String(fps),
    "-i",
    pattern,
    "-i",
    palette,
    "-lavfi",
    `${filters}[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=3:diff_mode=rectangle`,
    "-y",
    NodePath.join(OUT_DIR, `${id}.gif`),
  ]);
}

async function main(): Promise<void> {
  NodeFS.mkdirSync(OUT_DIR, { recursive: true });
  const work = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "solla-motion-"));
  try {
    const html = await bundle();
    await renderFrames(html, work);
    for (const composition of COMPOSITIONS) {
      await encode(composition.id, composition.fps, NodePath.join(work, composition.id), work);
    }
    // Hero still: the last frame of the first composition, at full resolution.
    const hero = COMPOSITIONS[0]!;
    NodeFS.copyFileSync(
      NodePath.join(work, hero.id, `${String(hero.durationInFrames - 1).padStart(5, "0")}.png`),
      NodePath.join(OUT_DIR, "solla-code-hero.png"),
    );
  } finally {
    NodeFS.rmSync(work, { recursive: true, force: true });
  }
  process.stdout.write(`\nWrote ${OUT_DIR}\n`);
}

await main();
