/**
 * Remote-control streaming benchmark. One command:
 *
 *   node apps/desktop/scripts/remote-control-bench/run.ts [options]
 *
 * Measures source-change-to-viewer-callback latency, input-to-callback latency, bytes on the
 * wire and legibility for the legacy pipeline (MediaRecorder/JPEG over
 * base64 RPC) and the media channel (WebCodecs over binary WebSocket), with a
 * synthetic desktop, a laptop-sized Chromium viewer (Electron, hidden
 * windows) and a phone-sized WebKit viewer (Playwright, headless), across
 * emulated links. Writes raw per-run logs and a summary to --out
 * (default /tmp/rc-bench). Everything it starts it stops: the relay process by
 * the PID it spawned, Electron and WebKit through their drivers.
 *
 * Options (comma lists): --pipelines legacy,media --scenes
 * idle,typing,scroll,video,input --viewers phone,laptop[,phone-mse]
 * --conditions loopback,wifi,cellular --seconds 12 --warmup 3 --repeats 1
 */
// @effect-diagnostics nodeBuiltinImport:off - benchmark driver runs only under Node
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";

import { measureStaleness, measureUpdates, stats, type Stats } from "./stats.ts";

import { LOOPBACK, startLinkEmulator, type LinkConditions } from "./linkEmulator.ts";

const here = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const desktopRoot = NodePath.resolve(here, "../..");
const repoRoot = NodePath.resolve(desktopRoot, "../..");
const require = NodeModule.createRequire(NodePath.join(desktopRoot, "package.json"));

const CONDITIONS: Record<string, LinkConditions> = {
  loopback: LOOPBACK,
  // A good phone link: 40 ms round trip, 20 Mbps, a deep buffer.
  wifi: { name: "wifi", rttMs: 40, rateBitsPerSecond: 20_000_000, bufferMs: 400 },
  // A constrained one: same round trip, 5 Mbps.
  cellular: { name: "cellular", rttMs: 40, rateBitsPerSecond: 5_000_000, bufferMs: 400 },
};

const { values: args } = NodeUtil.parseArgs({
  options: {
    pipelines: { type: "string", default: "legacy,media" },
    scenes: { type: "string", default: "idle,typing,scroll,video,input" },
    viewers: { type: "string", default: "phone,laptop" },
    conditions: { type: "string", default: "loopback,wifi,cellular" },
    seconds: { type: "string", default: "12" },
    warmup: { type: "string", default: "3" },
    repeats: { type: "string", default: "1" },
    out: { type: "string", default: "/tmp/rc-bench" },
    tag: { type: "string", default: "" },
    images: { type: "boolean", default: false },
    "build-only": { type: "boolean", default: false },
  },
});
const list = (value: string | undefined) => (value ?? "").split(",").filter(Boolean);
const outDir = NodePath.resolve(args.out!);
const rawDir = NodePath.join(outDir, "raw");
NodeFS.mkdirSync(rawDir, { recursive: true });

type Pipeline = "legacy" | "media";
type Scene = "idle" | "caret" | "typing" | "scroll" | "video" | "input";
type Viewer = "phone" | "phone-mse" | "laptop";

interface RunResult {
  readonly pipeline: Pipeline;
  readonly scene: Scene;
  readonly viewer: Viewer;
  readonly condition: string;
  readonly repeat: number;
  readonly seconds: number;
  readonly latency: Stats | null;
  readonly inputToViewer: Stats | null;
  readonly inputUpdates: number;
  readonly missedInputs: number;
  readonly supersededUpdates: number;
  readonly missedUpdates: number;
  readonly exactFrameLatency: Stats | null;
  readonly outstandingUpdateAge: Stats | null;
  readonly blackoutSamples: number;
  readonly ageSampleIntervalMs: number;
  readonly displayedUpdatesPerSecond: number;
  readonly rawTiming: {
    readonly draws: ReadonlyArray<readonly [number, number]>;
    readonly displayed: ReadonlyArray<readonly [number, number]>;
    readonly sent: ReadonlyArray<readonly [number, number]>;
    readonly from: number;
    readonly until: number;
  };
  readonly framesDrawn: number;
  readonly framesShown: number;
  readonly downstreamBytesPerSecond: number;
  readonly upstreamBytesPerSecond: number;
  readonly legibility: { psnr: number; width: number; height: number } | null;
  readonly host: Record<string, unknown>;
  readonly viewerCounters: Record<string, unknown>;
}

const round = (value: number) => Math.round(value * 10) / 10;
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

async function buildPages(buildDir: string): Promise<void> {
  const { build } = await import("vite-plus");
  for (const name of ["host", "viewer"]) {
    await build({
      configFile: false,
      logLevel: "warn",
      root: here,
      build: {
        outDir: buildDir,
        emptyOutDir: false,
        minify: false,
        target: "es2022",
        lib: {
          entry: NodePath.join(here, `${name}.ts`),
          formats: ["es"],
          fileName: () => `${name}.js`,
        },
      },
    });
    NodeFS.writeFileSync(
      NodePath.join(buildDir, `${name}.html`),
      `<!doctype html><meta charset="utf-8"><title>${name}</title><body><script type="module" src="./${name}.js"></script></body>`,
    );
  }
}

function startRelay(
  buildDir: string,
): Promise<{ child: NodeChildProcess.ChildProcess; port: number }> {
  const child = NodeChildProcess.spawn(
    process.execPath,
    [NodePath.join(repoRoot, "apps/server/scripts/remote-control-bench-server.ts")],
    {
      cwd: NodePath.join(repoRoot, "apps/server"),
      env: { ...process.env, BENCH_STATIC_DIR: buildDir },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.stderr!.on("data", (chunk: Buffer) => process.stderr.write(`[relay] ${chunk}`));
  return new Promise((done, fail) => {
    let buffered = "";
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("Relay did not become ready within 30 seconds"));
    }, 30_000);
    const cleanup = () => {
      clearTimeout(timeout);
      child.off("error", reject);
      child.off("exit", onExit);
      child.stdout!.off("data", onData);
    };
    const reject = (error: Error) => {
      cleanup();
      fail(error);
    };
    const onExit = (code: number | null) => reject(new Error(`relay exited early (${code})`));
    const onData = (chunk: Buffer) => {
      buffered = (buffered + chunk.toString()).slice(-8_192);
      const match = /READY (\d+)/.exec(buffered);
      if (match) {
        cleanup();
        done({ child, port: Number(match[1]) });
      }
    };
    child.stdout!.on("data", onData);
    child.once("error", reject);
    child.once("exit", onExit);
  });
}

interface BenchPage {
  evaluate<T>(fn: string): Promise<T>;
  reload(): Promise<void>;
}

/** Page clock minus this process's clock, from the tightest of several probes. */
async function clockOffset(page: BenchPage): Promise<number> {
  let best = { rtt: Number.POSITIVE_INFINITY, offset: 0 };
  for (let attempt = 0; attempt < 7; attempt += 1) {
    const before = performance.timeOrigin + performance.now();
    const pageNow = await page.evaluate<number>("window.bench.now()");
    const after = performance.timeOrigin + performance.now();
    if (after - before < best.rtt) {
      best = { rtt: after - before, offset: pageNow - (before + after) / 2 };
    }
  }
  return best.offset;
}

async function waitForBench(page: BenchPage): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (await page.evaluate<boolean>("typeof window.bench === 'object'").catch(() => false)) return;
    await sleep(50);
  }
  throw new Error("benchmark page did not load");
}

async function main(): Promise<void> {
  const pipelines = list(args.pipelines) as Pipeline[];
  const scenes = list(args.scenes) as Scene[];
  const viewers = list(args.viewers) as Viewer[];
  const conditions = list(args.conditions).map((name) => {
    const condition = CONDITIONS[name];
    if (!condition) throw new Error(`unknown condition ${name}`);
    return condition;
  });
  const seconds = Number(args.seconds);
  const warmup = Number(args.warmup);
  const repeats = Number(args.repeats);
  for (const pipeline of pipelines)
    if (!["legacy", "media"].includes(pipeline)) throw new Error(`Unknown pipeline: ${pipeline}`);
  for (const scene of scenes)
    if (!["idle", "caret", "typing", "scroll", "video", "input"].includes(scene))
      throw new Error(`Unknown scene: ${scene}`);
  for (const viewer of viewers)
    if (!["phone", "phone-mse", "laptop"].includes(viewer))
      throw new Error(`Unknown viewer: ${viewer}`);
  if (
    !Number.isFinite(seconds) ||
    seconds <= 1 ||
    !Number.isFinite(warmup) ||
    warmup < 0 ||
    !Number.isInteger(repeats) ||
    repeats < 1
  )
    throw new Error("Require seconds > 1, warmup >= 0, and integer repeats >= 1");

  const cleanup: Array<() => Promise<unknown> | void> = [];
  const results: RunResult[] = [];
  try {
    const scratch = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "rc-bench-"));
    cleanup.push(() => NodeFS.rmSync(scratch, { recursive: true, force: true }));
    const buildDir = NodePath.join(outDir, "build");
    NodeFS.mkdirSync(buildDir, { recursive: true });
    await buildPages(buildDir);
    if (args["build-only"]) return;

    const relay = await startRelay(buildDir);
    cleanup.push(() => {
      relay.child.kill("SIGTERM");
    });
    const link = await startLinkEmulator(relay.port);
    cleanup.push(() => link.close());
    const { _electron, webkit } = require("playwright-core") as typeof import("playwright-core");

    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] =>
          entry[0] !== "ELECTRON_RUN_AS_NODE" && entry[1] !== undefined,
      ),
    );
    const electronApp = await _electron.launch({
      executablePath: require("electron") as unknown as string,
      args: [
        NodePath.join(here, "electron-main.cjs"),
        `--user-data-dir=${NodePath.join(scratch, "electron")}`,
        "--force-device-scale-factor=2",
      ],
      env: {
        ...env,
        BENCH_HOST_URL: `http://127.0.0.1:${relay.port}/bench/host.html`,
        BENCH_VIEWER_URL: `http://127.0.0.1:${link.port}/bench/viewer.html`,
      },
    });
    cleanup.push(() => electronApp.close());
    const webkitExecutable = process.env.BENCH_WEBKIT_EXECUTABLE;
    const browser = viewers.some((viewer) => viewer !== "laptop")
      ? await webkit.launch({
          headless: true,
          ...(webkitExecutable ? { executablePath: webkitExecutable } : {}),
        })
      : null;
    if (browser) cleanup.push(() => browser.close());
    const windows = async () => {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const pages = electronApp.windows();
        const host = pages.find((page) => page.url().includes("host.html"));
        const viewer = pages.find((page) => page.url().includes("viewer.html"));
        if (host && viewer) return { host, viewer };
        await sleep(100);
      }
      throw new Error("Electron windows did not open");
    };
    const electronPages = await windows();
    const asBench = (page: import("playwright-core").Page): BenchPage => ({
      evaluate: (fn) => page.evaluate(fn),
      reload: async () => {
        await page.reload();
      },
    });
    const host = asBench(electronPages.host);
    const laptop = asBench(electronPages.viewer);
    electronPages.host.on("console", (message) => {
      if (message.type() === "error") console.error(`[host] ${message.text()}`);
    });
    electronPages.viewer.on("console", (message) => {
      if (message.type() === "error") console.error(`[laptop] ${message.text()}`);
    });

    const phonePage = async (keepMediaSource: boolean) => {
      if (!browser) throw new Error("WebKit was not started for this viewer");
      const context = await browser.newContext({
        viewport: { width: 390, height: 844 },
        deviceScaleFactor: 3,
        hasTouch: true,
      });
      if (!keepMediaSource) {
        // Simulate the no-MediaSource capability path used by phone clients.
        // Desktop WebKit at phone dimensions is not physical iOS Safari proof.
        await context.addInitScript("delete window.MediaSource;");
      }
      const page = await context.newPage();
      page.on("console", (message) => {
        if (message.type() === "error") console.error(`[phone] ${message.text()}`);
      });
      await page.goto(`http://127.0.0.1:${link.port}/bench/viewer.html`);
      return asBench(page);
    };
    const viewerPages: Partial<Record<Viewer, BenchPage>> = { laptop };
    if (viewers.includes("phone")) viewerPages.phone = await phonePage(false);
    if (viewers.includes("phone-mse")) viewerPages["phone-mse"] = await phonePage(true);

    await waitForBench(host);
    for (const viewer of viewers) await waitForBench(viewerPages[viewer]!);
    for (const viewer of viewers) {
      const environment = await viewerPages[viewer]!.evaluate<Record<string, unknown>>(
        "window.bench.environment()",
      );
      console.log(`[env] ${viewer}: ${JSON.stringify(environment)}`);
    }

    for (const condition of conditions) {
      link.setConditions(condition);
      for (const viewer of viewers) {
        for (const scene of scenes) {
          for (const pipeline of pipelines) {
            for (let repeat = 0; repeat < repeats; repeat += 1) {
              const viewerPage = viewerPages[viewer]!;
              await host.reload();
              await viewerPage.reload();
              await waitForBench(host);
              await waitForBench(viewerPage);
              const result = await runOne({
                host,
                viewerPage,
                link,
                pipeline,
                scene,
                viewer,
                condition: condition.name,
                repeat,
                seconds,
                warmup,
              });
              results.push(result);
              NodeFS.writeFileSync(
                NodePath.join(
                  rawDir,
                  `${condition.name}-${viewer}-${scene}-${pipeline}-${repeat}.json`,
                ),
                JSON.stringify(result, null, 2),
              );
              console.log(summaryLine(result));
            }
          }
        }
      }
    }
  } finally {
    for (const close of cleanup.toReversed()) {
      try {
        await close();
      } catch (error) {
        console.error("benchmark cleanup failed", error);
      }
    }
  }
  const stamp = args.tag ? `-${args.tag}` : "";
  NodeFS.writeFileSync(
    NodePath.join(outDir, `results${stamp}.json`),
    JSON.stringify(results, null, 2),
  );
  console.log(`\nwrote ${NodePath.join(outDir, `results${stamp}.json`)}`);
}

function summaryLine(result: RunResult): string {
  const latency = result.latency
    ? `update→viewer p50 ${result.latency.p50}ms p95 ${result.latency.p95}ms`
    : "no frames";
  const input = result.inputToViewer
    ? ` input p50 ${result.inputToViewer.p50}ms p95 ${result.inputToViewer.p95}ms`
    : "";
  const psnr = result.legibility ? ` psnr ${result.legibility.psnr.toFixed(2)}dB` : "";
  return (
    `${result.condition.padEnd(8)} ${result.viewer.padEnd(9)} ${result.scene.padEnd(6)} ` +
    `${result.pipeline.padEnd(6)} ${latency}${input} shown ${result.framesShown}/${result.framesDrawn} superseded ${result.supersededUpdates} missed ${result.missedUpdates} ` +
    `down ${Math.round(result.downstreamBytesPerSecond / 1_024)} KiB/s up ${Math.round(
      result.upstreamBytesPerSecond / 1_024,
    )} KiB/s${psnr}`
  );
}

async function runOne(input: {
  readonly host: BenchPage;
  readonly viewerPage: BenchPage;
  readonly link: Awaited<ReturnType<typeof startLinkEmulator>>;
  readonly pipeline: Pipeline;
  readonly scene: Scene;
  readonly viewer: Viewer;
  readonly condition: string;
  readonly repeat: number;
  readonly seconds: number;
  readonly warmup: number;
}): Promise<RunResult> {
  const { host, viewerPage, link } = input;
  await host.evaluate(
    `window.bench.start(${JSON.stringify({ pipeline: input.pipeline, scene: input.scene })})`,
  );
  await viewerPage.evaluate(
    `window.bench.start(${JSON.stringify({
      pipeline: input.pipeline,
      ...(input.scene === "input" ? { typeEveryMs: 150 } : {}),
    })})`,
  );
  await sleep(input.warmup * 1_000);
  const hostOffset = await clockOffset(host);
  const viewerOffset = await clockOffset(viewerPage);
  link.reset();
  const t0 = performance.timeOrigin + performance.now();
  await sleep(input.seconds * 1_000);
  const t1 = performance.timeOrigin + performance.now();
  const bytes = link.snapshot().filter((entry) => entry.path.startsWith("/ws"));
  const legibility =
    input.scene === "idle" || input.scene === "typing"
      ? await viewerPage
          .evaluate<{ psnr: number; width: number; height: number } | null>(
            `window.bench.score(${JSON.stringify(input.scene)})`,
          )
          .catch(() => null)
      : null;
  if (args.images && legibility) {
    const images = await viewerPage
      .evaluate<{ received: string; truth: string } | null>(
        `window.bench.images(${JSON.stringify(input.scene)})`,
      )
      .catch(() => null);
    for (const [name, url] of Object.entries(images ?? {})) {
      NodeFS.writeFileSync(
        NodePath.join(
          rawDir,
          `${input.condition}-${input.viewer}-${input.scene}-${input.pipeline}-${name}.png`,
        ),
        Buffer.from(url.split(",")[1] ?? "", "base64"),
      );
    }
  }
  const drawLog = await host.evaluate<Array<[number, number]>>("window.bench.drawLog()");
  const shownLog = await viewerPage.evaluate<Array<[number, number]>>("window.bench.shownLog()");
  const sentLog = await viewerPage.evaluate<Array<[number, number]>>("window.bench.sentLog()");
  const hostCounters = await host.evaluate<Record<string, unknown>>("window.bench.counters()");
  const viewerCounters =
    await viewerPage.evaluate<Record<string, unknown>>("window.bench.counters()");
  await viewerPage.evaluate("window.bench.stop()").catch(() => undefined);
  await host.evaluate("window.bench.stop()").catch(() => undefined);

  const draws = drawLog.map(([frame, time]) => [frame, time - hostOffset] as const);
  const displayed = shownLog.map(([frame, time]) => [frame, time - viewerOffset] as const);
  const sent = sentLog.map(([index, time]) => [index + 1, time - viewerOffset] as const);
  // Leave one second for delivery, but count all earlier updates even when
  // they were skipped. The full logs allow a different censoring window.
  const window = { from: t0, until: t1 - 1_000, observedUntil: t1 };
  const updates = measureUpdates({ changes: draws, displayed, ...window });
  const inputs = measureUpdates({
    changes: input.scene === "input" ? sent : [],
    displayed,
    ...window,
  });
  const age = measureStaleness({ changes: draws, displayed, from: t0, until: t1 });
  const elapsed = (t1 - t0) / 1_000;
  return {
    pipeline: input.pipeline,
    scene: input.scene,
    viewer: input.viewer,
    condition: input.condition,
    repeat: input.repeat,
    seconds: round(elapsed),
    latency: stats(updates.latencies),
    inputToViewer: stats(inputs.latencies),
    inputUpdates: inputs.updates,
    missedInputs: inputs.missed,
    framesDrawn: updates.updates,
    framesShown: updates.exactLatencies.length,
    supersededUpdates: updates.superseded,
    missedUpdates: updates.missed,
    exactFrameLatency: stats(updates.exactLatencies),
    outstandingUpdateAge: stats(age.ages),
    blackoutSamples: age.blackoutSamples,
    ageSampleIntervalMs: age.sampleIntervalMs,
    displayedUpdatesPerSecond: round(
      displayed.filter(([, at]) => at >= t0 && at <= t1).length / elapsed,
    ),
    rawTiming: { draws, displayed, sent, from: t0, until: t1 },
    downstreamBytesPerSecond: Math.round(
      bytes.reduce((sum, entry) => sum + entry.downstream, 0) / elapsed,
    ),
    upstreamBytesPerSecond: Math.round(
      bytes.reduce((sum, entry) => sum + entry.upstream, 0) / elapsed,
    ),
    legibility: legibility
      ? {
          psnr: round(legibility.psnr * 10) / 10,
          width: legibility.width,
          height: legibility.height,
        }
      : null,
    host: hostCounters,
    viewerCounters,
  };
}

await main();
