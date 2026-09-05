/** Export README clips from production-client footage and captured pointer events. */
import * as NodeChildProcess from "node:child_process";
import * as NodeEvents from "node:events";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright-core";

const root = NodePath.resolve(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "../../../..",
);
const captures = NodePath.join(root, "tools/motion/captures");
const output = NodePath.join(root, "tools/motion/out/readme");
const destination = NodePath.join(root, "docs/media/readme");
const scenes = [
  {
    source: "voice",
    file: "voice-orchestrator",
    title: "Your workspace, spoken.",
    note: "Live voice response · Production client",
  },
  {
    source: "agents",
    file: "custom-agents",
    title: "Give every agent a purpose.",
    note: "Illustrative workspace · Production client",
  },
  {
    source: "terminals",
    file: "terminal-workspaces",
    title: "Read the code. Run the tests.",
    note: "Real commands · Production client",
  },
  {
    source: "artifact",
    file: "thread-artifacts",
    title: "Keep the result in reach.",
    note: "Illustrative artifact · Production client",
  },
  {
    source: "failover",
    file: "provider-failover",
    title: "Continue with another account.",
    note: "Controlled quota event · Production client",
  },
];
const requested = process.argv.find((arg) => arg.startsWith("--scene="))?.slice(8);
const selected = scenes.filter(
  (scene) => !requested || requested.split(",").includes(scene.source),
);
if (!selected.length) throw new Error(`Unknown scene: ${requested}`);
await NodeFSP.mkdir(output, { recursive: true });
await NodeFSP.mkdir(destination, { recursive: true });
const bundle = await build({
  entryPoints: [NodePath.join(root, "tools/motion/src/film/gifEntry.ts")],
  bundle: true,
  write: false,
  format: "iife",
  platform: "browser",
});
const executablePath = [
  process.env.SOLLA_CHROMIUM,
  chromium.executablePath(),
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].find((value) => value && NodeFS.existsSync(value));
if (!executablePath) throw new Error("Install Chromium or set SOLLA_CHROMIUM.");
const browser = await chromium.launch({
  executablePath,
  args: ["--allow-file-access-from-files", "--force-color-profile=srgb"],
});
try {
  for (const scene of selected) {
    const source = NodePath.join(captures, `${scene.source}.mp4`);
    const metadata = JSON.parse(
      await NodeFSP.readFile(NodePath.join(captures, `${scene.source}-source.json`), "utf8"),
    ) as {
      viewport: { width: number; height: number };
      duration: number;
      actions?: { at: number; x: number; y: number }[];
    };
    const width = Math.min(1100, metadata.viewport.width);
    const scale = width / metadata.viewport.width;
    const height = Math.round((metadata.viewport.height * scale) / 2) * 2;
    const assets = {
      ...scene,
      width,
      height,
      source: NodeURL.pathToFileURL(source).href,
      actions: (metadata.actions ?? []).map((action) => ({
        ...action,
        x: action.x * scale,
        y: action.y * scale,
      })),
    };
    const html = NodePath.join(output, `${scene.source}.html`);
    await NodeFSP.writeFile(
      html,
      `<!doctype html><meta charset="utf-8"><body><script>window.clipAssets=${JSON.stringify(assets)}</script><script>${bundle.outputFiles[0]!.text}</script></body>`,
    );
    const page = await browser.newPage({ viewport: { width, height: height + 58 } });
    const intermediate = NodePath.join(output, `${scene.source}.mp4`);
    const encoder = NodeChildProcess.spawn(
      "ffmpeg",
      [
        "-y",
        "-loglevel",
        "error",
        "-f",
        "image2pipe",
        "-framerate",
        "15",
        "-i",
        "pipe:0",
        "-c:v",
        "libx264",
        "-crf",
        "15",
        "-pix_fmt",
        "yuv420p",
        intermediate,
      ],
      { stdio: ["pipe", "ignore", "pipe"] },
    );
    let errors = "";
    encoder.stderr.on("data", (chunk) => {
      errors = (errors + String(chunk)).slice(-8000);
    });
    const completion = NodeEvents.EventEmitter.once(encoder, "close");
    try {
      await page.goto(NodeURL.pathToFileURL(html).href);
      await page.evaluate(() => window.clip.ready());
      const frames = Math.ceil(metadata.duration * 15);
      for (let frame = 0; frame < frames; frame++) {
        await page.evaluate((time) => window.clip.frame(time), frame / 15);
        const png = await page.screenshot({ type: "png" });
        if (!encoder.stdin.write(png)) await NodeEvents.EventEmitter.once(encoder.stdin, "drain");
      }
      encoder.stdin.end();
      const [code] = await completion;
      if (code !== 0) throw new Error(errors);
      const gif = NodePath.join(destination, `${scene.file}.gif`);
      NodeChildProcess.execFileSync(
        "ffmpeg",
        [
          "-y",
          "-loglevel",
          "error",
          "-i",
          intermediate,
          "-filter_complex",
          "split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=sierra2_4a:diff_mode=rectangle",
          "-loop",
          "0",
          gif,
        ],
        { stdio: "pipe" },
      );
      await NodeFSP.writeFile(
        NodePath.join(output, `${scene.file}-proof.json`),
        JSON.stringify(
          {
            title: scene.title,
            note: scene.note,
            duration: frames / 15,
            source: `${scene.source}.mp4`,
            sourceSha256: NodeCrypto.createHash("sha256")
              .update(await NodeFSP.readFile(source))
              .digest("hex"),
            width,
            height: height + 58,
            actions: assets.actions,
          },
          null,
          2,
        ),
      );
      process.stdout.write(`Rendered ${scene.file}\n`);
    } catch (error) {
      encoder.kill("SIGTERM");
      throw error;
    } finally {
      await page.close();
    }
  }
} finally {
  await browser.close();
}
