/** Render original motion graphics around recordings of the production client. */
import * as NodeChildProcess from "node:child_process";
import * as NodeEvents from "node:events";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright-core";
import { FPS, SCENE_SECONDS, SCENES } from "./scenes.ts";

const root = NodePath.resolve(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "../../../..",
);
const motion = NodePath.join(root, "tools/motion");
const output = NodePath.join(motion, "out/product-film");
const publicMedia = NodePath.join(root, "apps/marketing/public/media");
const preview = process.argv.includes("--preview");
const selectedId = process.argv.find((value) => value.startsWith("--scene="))?.slice(8);
const selected = SCENES.map((scene, index) => ({ scene, index })).filter(
  ({ scene }) => !selectedId || scene.id === selectedId,
);
if (selected.length === 0) throw new Error(`Unknown scene: ${selectedId}`);

async function command(binary: string, args: string[]) {
  const child = NodeChildProcess.spawn(binary, args, { stdio: ["ignore", "ignore", "pipe"] });
  let error = "";
  child.stderr.on("data", (chunk: Buffer) => {
    error = (error + chunk.toString()).slice(-16000);
  });
  const [code] = await NodeEvents.EventEmitter.once(child, "close");
  if (code !== 0) throw new Error(`${binary} failed (${code}): ${error}`);
}

await NodeFSP.mkdir(output, { recursive: true });
await NodeFSP.mkdir(publicMedia, { recursive: true });
const sources: Record<string, string> = {};
for (const scene of SCENES) {
  if (!scene.source) continue;
  const file = NodePath.join(motion, "captures", `${scene.source}.mp4`);
  if (!NodeFS.existsSync(file)) {
    if (selected.some((entry) => entry.scene.source === scene.source))
      throw new Error(`Record the real app first: ${file}`);
    continue;
  }
  sources[scene.source] = NodeURL.pathToFileURL(file).href;
}
const font = NodeURL.pathToFileURL(
  NodePath.join(root, "apps/marketing/public/fonts/dm-sans-latin.woff2"),
).href;
const logo = NodeURL.pathToFileURL(
  NodePath.join(root, "apps/marketing/public/brand/solla-bolt.svg"),
).href;
const mesh = JSON.parse(
  await NodeFSP.readFile(
    NodePath.join(root, "apps/marketing/public/brand/solla-bolt.mesh.json"),
    "utf8",
  ),
);
const bundle = await build({
  entryPoints: [NodePath.join(motion, "src/film/entry.ts")],
  bundle: true,
  write: false,
  format: "iife",
  platform: "browser",
  target: "chrome120",
});
const html = `<!doctype html><meta charset="utf-8"><body><script>window.filmAssets=${JSON.stringify({ mesh, sources, font, logo })}</script><script>${bundle.outputFiles[0]!.text}</script></body>`;
const pagePath = NodePath.join(output, "film.html");
await NodeFSP.writeFile(pagePath, html);
const candidates = [
  chromium.executablePath(),
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
];
const executablePath = candidates.find(NodeFS.existsSync);
if (!executablePath) throw new Error("Install Chromium before rendering.");
const browser = await chromium.launch({
  executablePath,
  args: [
    "--force-color-profile=srgb",
    "--font-render-hinting=none",
    "--allow-file-access-from-files",
  ],
});
try {
  const page = await browser.newPage({
    viewport: { width: 1920, height: 1080 },
    deviceScaleFactor: 1,
  });
  page.on("pageerror", (error) => process.stderr.write(`Film page: ${error.message}\n`));
  await page.goto(NodeURL.pathToFileURL(pagePath).href);
  await page.evaluate(() => window.film.ready());
  for (const { scene, index } of selected) {
    process.stdout.write(`Rendering ${scene.id}\n`);
    const frames = preview
      ? [30, 90, 150, 225]
      : Array.from({ length: SCENE_SECONDS * FPS }, (_, frame) => frame);
    const encoder = preview
      ? null
      : NodeChildProcess.spawn(
          "ffmpeg",
          [
            "-y",
            "-loglevel",
            "error",
            "-f",
            "image2pipe",
            "-framerate",
            String(FPS),
            "-i",
            "pipe:0",
            "-c:v",
            "libx264",
            "-preset",
            "fast",
            "-crf",
            "17",
            "-pix_fmt",
            "yuv420p",
            "-movflags",
            "+faststart",
            NodePath.join(output, `${scene.id}.mp4`),
          ],
          { stdio: ["pipe", "ignore", "pipe"] },
        );
    let encoderError = "";
    encoder?.stderr.on("data", (chunk: Buffer) => {
      encoderError = (encoderError + chunk.toString()).slice(-8000);
    });
    const completion = encoder ? NodeEvents.EventEmitter.once(encoder, "close") : null;
    try {
      for (const frame of frames) {
        await page.evaluate(({ index, frame }) => window.film.frame(index, frame), {
          index,
          frame,
        });
        const png = await page.screenshot({ type: "png", animations: "disabled" });
        if (preview)
          await NodeFSP.writeFile(
            NodePath.join(output, `${scene.id}-${String(frame).padStart(3, "0")}.png`),
            png,
          );
        else if (!encoder!.stdin.write(png))
          await NodeEvents.EventEmitter.once(encoder!.stdin, "drain");
      }
      encoder?.stdin.end();
      if (completion) {
        const [code] = await completion;
        if (code !== 0) throw new Error(`Encoder failed: ${encoderError}`);
      }
    } catch (error) {
      encoder?.kill("SIGTERM");
      throw error;
    }
  }
} finally {
  await browser.close();
}

// A single-scene render is a review artifact. Only a full run may publish the
// assembled film, so an older chapter cannot silently enter a fresh release.
if (!preview && !selectedId) {
  const concat = NodePath.join(output, "chapters.txt");
  await NodeFSP.writeFile(
    concat,
    SCENES.map(
      (scene) => `file '${NodePath.join(output, `${scene.id}.mp4`).replaceAll("'", "'\\''")}'`,
    ).join("\n"),
  );
  await command("ffmpeg", [
    "-y",
    "-loglevel",
    "error",
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    concat,
    "-i",
    NodePath.join(publicMedia, "solla-code-score.wav"),
    "-c:v",
    "copy",
    "-af",
    "loudnorm=I=-16:TP=-1.5:LRA=9",
    "-c:a",
    "aac",
    "-b:a",
    "256k",
    "-t",
    String(SCENES.length * SCENE_SECONDS),
    "-movflags",
    "+faststart",
    NodePath.join(publicMedia, "solla-code-film.mp4"),
  ]);
  const stamp = (seconds: number) =>
    `00:${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}.000`;
  const vtt =
    "WEBVTT\n\n" +
    SCENES.map(
      (scene, index) =>
        `${index + 1}\n${stamp(index * SCENE_SECONDS)} --> ${stamp((index + 1) * SCENE_SECONDS)}\n${index === 0 ? "[Original electronic instrumental music]\n" : ""}${scene.title.join(" ")}\n${scene.description}\n`,
    ).join("\n");
  await NodeFSP.writeFile(NodePath.join(publicMedia, "solla-code-film.vtt"), vtt);
  await command("ffmpeg", [
    "-y",
    "-loglevel",
    "error",
    "-ss",
    "4",
    "-i",
    NodePath.join(publicMedia, "solla-code-film.mp4"),
    "-frames:v",
    "1",
    NodePath.join(publicMedia, "solla-code-film-poster.png"),
  ]);
  const sourceProof = await Promise.all(
    Object.keys(sources).map(async (source) => ({
      source: `${source}.mp4`,
      sha256: NodeCrypto.createHash("sha256")
        .update(await NodeFSP.readFile(NodePath.join(motion, "captures", `${source}.mp4`)))
        .digest("hex"),
    })),
  );
  await NodeFSP.writeFile(
    NodePath.join(output, "manifest.json"),
    JSON.stringify(
      {
        width: 1920,
        height: 1080,
        fps: FPS,
        durationSeconds: SCENES.length * SCENE_SECONDS,
        scenes: SCENES,
        sourceProof,
        art: "Author's mesh, original code graphics, and real production-client recordings",
        music: "Original deterministic synthesis, no samples or ML generation",
      },
      null,
      2,
    ),
  );
  process.stdout.write(`Film: ${NodePath.join(publicMedia, "solla-code-film.mp4")}\n`);
}
