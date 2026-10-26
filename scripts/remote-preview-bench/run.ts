// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalTimers:off globalDate:off - Standalone measurement harness; it drives a real Electron process and real sockets on wall-clock time.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";
import * as NodeURL from "node:url";

import * as Effect from "effect/Effect";

import { BENCH_ENVIRONMENT_ID, startRelayServer } from "./relayServer.ts";
import { sceneSampleLabel } from "./artifacts.ts";
import { waitWithTimeout } from "./deadline.ts";
import type { CompressionDiagnostic } from "./compressionDiagnostic.ts";
import { INPUT_TARGET } from "./scenes.mjs";
import { markLatencies, summarize, type LatencySummary } from "./stats.ts";
import { startThrottleProxy } from "./throttleProxy.ts";
import { createVideoViewerDriver, type VideoViewerDriver } from "./videoViewer.ts";
import {
  now,
  startPollingViewer,
  startStreamingViewer,
  type ReceivedEvent,
  type ViewerHandle,
  type ViewerSize,
} from "./viewer.ts";

/**
 * Remote preview bench: measures what a remote viewer of a desktop browser tab
 * gets (latency and bytes on the wire) for the polling viewer and the frame
 * stream, end to end through the production server code.
 *
 *   node scripts/remote-preview-bench/run.ts [--modes old,new] [--seconds 20]
 *     [--scenes idle,ticks,...] [--out /tmp/rp-bench/<run>] [--quick]
 *
 * It starts the bench server on a loopback port, launches the repo's Electron
 * with a throwaway profile and no visible window as the desktop host, plays
 * scripted scenes in a <webview>, and reads a counter marker back out of every
 * picture a viewer received. Raw samples, a JSON summary and a README land in
 * the output directory (default /tmp/rp-bench/<timestamp>).
 */

const here = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const repoRoot = NodePath.resolve(here, "../..");

type Mode = "old" | "old-agent" | "new" | "new-native" | "new-video";
let videoViewerDriver: VideoViewerDriver | null = null;
const activeViewers = new Set<ViewerHandle>();

const VIEWERS: ReadonlyArray<ViewerSize> = [
  // A phone in portrait: the frame box under Safari's chrome and the strip.
  { name: "phone", width: 390, height: 700, devicePixelRatio: 3 },
  // A browser window on a laptop.
  { name: "desktop", width: 1200, height: 720, devicePixelRatio: 2 },
];
// Polling requests one fixed image size and has no browser viewport to measure separately.
const SHARED_NODE_VIEWER: ViewerSize = { ...VIEWERS[0]!, name: "shared-node" };

const ALL_SCENES = ["idle", "ticks", "caret", "spinner", "typing", "scroll", "video"] as const;

interface Options {
  readonly modes: ReadonlyArray<Mode>;
  readonly seconds: number;
  readonly scenes: ReadonlyArray<string>;
  readonly out: string;
  readonly inputClicks: number;
  readonly firstFrameRuns: number;
  readonly slowLink: boolean;
  readonly buildOnly: boolean;
  readonly images: boolean;
}

function parseOptions(): Options {
  const args = process.argv.slice(2);
  const value = (name: string) => {
    const index = args.indexOf(`--${name}`);
    return index === -1 ? undefined : args[index + 1];
  };
  const quick = args.includes("--quick");
  const stamp = new Date().toISOString().replaceAll(":", "-").replace(/\..*/, "");
  const result: Options = {
    modes: (value("modes") ?? "old,new,new-native").split(",") as Array<Mode>,
    seconds: Number(value("seconds") ?? (quick ? 8 : 20)),
    scenes: (value("scenes") ?? ALL_SCENES.join(",")).split(","),
    out: value("out") ?? NodePath.join("/tmp/rp-bench", stamp),
    inputClicks: Number(value("clicks") ?? (quick ? 5 : 15)),
    firstFrameRuns: Number(value("first-frames") ?? (quick ? 3 : 8)),
    slowLink: !args.includes("--no-slow-link"),
    buildOnly: args.includes("--build-only"),
    images: args.includes("--images"),
  };
  if (
    !result.modes.length ||
    result.modes.some(
      (mode) => !["old", "old-agent", "new", "new-native", "new-video"].includes(mode),
    )
  ) {
    throw new Error("--modes must contain old, old-agent, new, new-native, or new-video");
  }
  if (
    !result.scenes.length ||
    result.scenes.some((scene) => !(ALL_SCENES as readonly string[]).includes(scene))
  ) {
    throw new Error("Unknown --scenes entry");
  }
  if (
    !Number.isFinite(result.seconds) ||
    result.seconds < 4 ||
    !Number.isSafeInteger(result.inputClicks) ||
    result.inputClicks < 1 ||
    !Number.isSafeInteger(result.firstFrameRuns) ||
    result.firstFrameRuns < 1
  ) {
    throw new Error("Use --seconds >= 4 and positive integer --clicks / --first-frames");
  }
  return result;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// The Electron host process

export interface HostProcess {
  readonly call: <A = unknown>(op: string, args?: unknown) => Promise<A>;
  readonly close: () => Promise<void>;
}

export async function startHost(out: string): Promise<HostProcess> {
  const electron = NodePath.join(
    repoRoot,
    "apps/desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron",
  );
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    BENCH_ENCODER_SCRIPT: NodePath.join(out, "renderer", "encoder.js"),
  };
  // A parent that is itself Electron (this harness may run inside the app)
  // exports this; with it set the child would run as plain Node.
  delete env.ELECTRON_RUN_AS_NODE;
  const child = NodeChildProcess.spawn(
    electron,
    [
      `--user-data-dir=${NodePath.join(out, "electron-profile")}`,
      NodePath.join(here, "electron-host.mjs"),
    ],
    { env, stdio: ["pipe", "pipe", "pipe"] },
  );
  const stderr = NodeFS.createWriteStream(NodePath.join(out, "electron-host.log"));
  child.stderr.pipe(stderr);
  const pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  let nextId = 1;
  let resolveReady: () => void = () => {};
  const ready = new Promise<void>((resolve) => (resolveReady = resolve));
  NodeReadline.createInterface({ input: child.stdout }).on("line", (line) => {
    if (!line.startsWith("@@RP ")) return;
    const message = JSON.parse(line.slice(5)) as {
      ready?: boolean;
      id?: number;
      ok?: boolean;
      result?: unknown;
      error?: string;
    };
    if (message.ready) {
      resolveReady();
      return;
    }
    const entry = pending.get(message.id ?? -1);
    if (!entry) return;
    pending.delete(message.id ?? -1);
    if (message.ok) entry.resolve(message.result);
    else entry.reject(new Error(message.error));
  });
  let closed = false;
  const exited = new Promise<void>((resolve) =>
    child.on("exit", () => {
      closed = true;
      for (const entry of pending.values()) entry.reject(new Error("Electron host exited"));
      pending.clear();
      stderr.end();
      resolve();
    }),
  );
  let startupTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      ready,
      new Promise<never>((_, reject) => {
        child.once("error", reject);
        startupTimer = setTimeout(
          () => reject(new Error("Electron startup timed out; see electron-host.log")),
          30_000,
        );
      }),
      exited.then(() => {
        throw new Error("Electron exited before ready; see electron-host.log");
      }),
    ]);
  } catch (error) {
    if (child.pid !== undefined && !closed) {
      child.kill("SIGKILL");
      await exited;
    }
    throw error;
  } finally {
    clearTimeout(startupTimer);
  }
  return {
    call: <A>(op: string, args?: unknown) =>
      new Promise<A>((resolve, reject) => {
        if (closed) {
          reject(new Error("Electron host exited"));
          return;
        }
        const id = nextId++;
        pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
        child.stdin.write(`${JSON.stringify({ id, op, args })}\n`);
      }),
    close: async () => {
      if (closed) return;
      child.stdin.write(`${JSON.stringify({ id: 0, op: "quit" })}\n`);
      if ((await waitWithTimeout(exited, 5_000, "timeout")) === "timeout") {
        // Only the PID this harness spawned, never a name match.
        child.kill("SIGKILL");
        await exited;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Viewers

async function startViewer(mode: Mode, url: string, size: ViewerSize): Promise<ViewerHandle> {
  let handle: ViewerHandle;
  switch (mode) {
    case "new-video":
      if (!videoViewerDriver) throw new Error("The video viewer driver was not initialized.");
      handle = await videoViewerDriver.start(url, size);
      break;
    case "old":
      handle = await startPollingViewer({ url, intervalMs: 2_500 });
      break;
    case "old-agent":
      handle = await startPollingViewer({ url, intervalMs: 1_000 });
      break;
    case "new":
    case "new-native":
      handle = await startStreamingViewer({ url, size, patches: mode !== "new-native" });
      break;
  }
  let stopped = false;
  const owned: ViewerHandle = {
    ...handle,
    stop: async () => {
      if (stopped) return;
      stopped = true;
      try {
        await handle.stop();
      } finally {
        activeViewers.delete(owned);
      }
    },
  };
  activeViewers.add(owned);
  return owned;
}

/** Reads the marker out of every picture a viewer received, via the host's decoder. */
interface DecodedMarker {
  readonly at: number;
  readonly marker: number | null;
  readonly width: number | null;
  readonly height: number | null;
  readonly decodedAt?: number;
}

async function decodeMarkers(
  host: HostProcess,
  out: string,
  label: string,
  events: ReadonlyArray<ReceivedEvent>,
  images = false,
): Promise<DecodedMarker[]> {
  if (events.some((event) => event.kind === "video")) {
    return events.filter((event) => event.kind === "video");
  }
  const input = NodePath.join(out, "frames", `${label}.ndjson`);
  const output = NodePath.join(out, "frames", `${label}.markers.ndjson`);
  NodeFS.writeFileSync(input, events.map((event) => JSON.stringify(event)).join("\n"));
  await host.call("decode", { input, output });
  const markers = NodeFS.readFileSync(output, "utf8")
    .split("\n")
    .filter(Boolean)
    .map(
      (line) =>
        JSON.parse(line) as {
          at: number;
          marker: number | null;
          width: number | null;
          height: number | null;
        },
    );
  // Raw pictures are large; keep the decoded markers, drop the pixels.
  NodeFS.rmSync(input);
  if (images) {
    const sourceIndex = events.findLastIndex((event) => event.kind === "full");
    const source = events[sourceIndex];
    if (source?.kind !== "full") throw new Error("No full frame for compression diagnostic");
    const diagnostic = await host.call<CompressionDiagnostic>("compression", { data: source.data });
    const imageDir = NodePath.join(out, "images");
    NodeFS.mkdirSync(imageDir, { recursive: true });
    const writeImage = (suffix: string, data: string) =>
      NodeFS.writeFileSync(
        NodePath.join(imageDir, `${label}-${suffix}`),
        Buffer.from(data, "base64"),
      );
    writeImage("source.jpg", source.data);
    writeImage("source.png", diagnostic.sourcePng);
    const variants = diagnostic.variants.map(({ data, decodedPng, ...variant }) => {
      writeImage(`${variant.name}.${variant.mimeType === "image/webp" ? "webp" : "jpg"}`, data);
      writeImage(`${variant.name}.png`, decodedPng);
      return variant;
    });
    NodeFS.writeFileSync(
      NodePath.join(imageDir, `${label}.json`),
      JSON.stringify(
        {
          source: { ...markers[sourceIndex], jpegBytes: Buffer.byteLength(source.data, "base64") },
          width: diagnostic.width,
          height: diagnostic.height,
          variants,
        },
        null,
        2,
      ),
    );
  }
  return markers;
}

interface SceneResult {
  readonly scene: string;
  readonly mode: Mode;
  readonly viewer: string;
  readonly condition: "loopback" | "slow";
  readonly seconds: number;
  readonly changeToReceived: LatencySummary;
  readonly missed: number;
  readonly bytesReadPerSecond: number;
  readonly bytesWrittenPerSecond: number;
  readonly megabytesPerHour: number;
  readonly firstPictureBytes: number;
  readonly pictures: number;
  readonly pictureSizes: ReadonlyArray<string>;
  readonly undecodable: number;
  readonly hostCounters: unknown;
  readonly changeToDecoded?: LatencySummary;
  readonly viewerStats?: unknown;
}

async function measureScene(
  host: HostProcess,
  options: Options,
  url: string,
  scene: string,
  mode: Mode,
  viewer: ViewerSize,
  condition: "loopback" | "slow" = "loopback",
): Promise<SceneResult> {
  await host.call("scene", { name: scene });
  const handle = await startViewer(mode, url, viewer);
  const startedAt = now();
  if ((await waitWithTimeout(handle.firstPictureAt, 10_000, null)) === null) {
    await handle.stop();
    throw new Error("Viewer produced no first picture within 10 seconds");
  }
  // Steady state starts once the first picture is in and two seconds passed.
  await sleep(2_000);
  const firstPictureBytes = handle.bytes().read;
  const steadyFrom = now();
  const bytesAtSteady = handle.bytes();
  await sleep(options.seconds * 1_000);
  const steadyUntil = now();
  const bytesAtEnd = handle.bytes();
  const hostCounters = await host.call("counters");
  await handle.stop();
  const marks = await host.call<Array<[number, number]>>("marks");
  const label = sceneSampleLabel({ scene, mode, viewer: viewer.name, condition });
  const received = await decodeMarkers(host, options.out, label, handle.events, options.images);
  const image = handle.image?.();
  if (options.images && image) {
    NodeFS.mkdirSync(NodePath.join(options.out, "images"), { recursive: true });
    NodeFS.writeFileSync(
      NodePath.join(options.out, "images", `${label}-received.png`),
      Buffer.from(image, "base64"),
    );
  }
  const { latencies, missed } = markLatencies({
    marks,
    received,
    from: steadyFrom,
    // Changes in the last 3 s may legitimately still be on their way (the
    // polling viewer asks every 2.5 s).
    until: steadyUntil - 3_000,
  });
  const seconds = (steadyUntil - steadyFrom) / 1_000;
  const readPerSecond = (bytesAtEnd.read - bytesAtSteady.read) / seconds;
  const result: SceneResult = {
    scene,
    mode,
    viewer: viewer.name,
    condition,
    seconds,
    changeToReceived: summarize(latencies),
    missed,
    bytesReadPerSecond: readPerSecond,
    bytesWrittenPerSecond: (bytesAtEnd.written - bytesAtSteady.written) / seconds,
    megabytesPerHour:
      ((readPerSecond + (bytesAtEnd.written - bytesAtSteady.written) / seconds) * 3_600) / 1e6,
    firstPictureBytes,
    pictures: handle.events.filter((event) => event.kind !== "same").length,
    pictureSizes: Array.from(
      new Set(
        received
          .filter((frame) => frame.width !== null && frame.height !== null)
          .map((frame) => `${frame.width}x${frame.height}`),
      ),
    ),
    undecodable: received.filter((frame) => frame.marker === null).length,
    hostCounters,
    ...(mode === "new-video"
      ? {
          viewerStats: handle.viewerStats?.(),
          changeToDecoded: summarize(
            markLatencies({
              marks,
              received: received.map((frame) => ({ ...frame, at: frame.decodedAt ?? frame.at })),
              from: steadyFrom,
              until: steadyUntil - 3_000,
            }).latencies,
          ),
        }
      : {}),
  };
  NodeFS.writeFileSync(
    NodePath.join(options.out, "samples", `${label}.json`),
    JSON.stringify({ startedAt, steadyFrom, steadyUntil, marks, received, latencies, result }),
  );
  return result;
}

async function measureInput(
  host: HostProcess,
  options: Options,
  url: string,
  mode: Mode,
  viewer: ViewerSize,
) {
  await host.call("scene", { name: "input" });
  const handle = await startViewer(mode, url, viewer);
  if ((await waitWithTimeout(handle.firstPictureAt, 10_000, null)) === null) {
    await handle.stop();
    throw new Error("Viewer produced no first picture within 10 seconds");
  }
  await sleep(1_500);
  const sends: Array<{ at: number; marker: number }> = [];
  for (let index = 0; index < options.inputClicks; index++) {
    const marks = await host.call<Array<[number, number]>>("marks");
    const current = marks.at(-1)?.[0] ?? 1;
    sends.push({ at: now(), marker: current + 1 });
    await handle.input({ kind: "click", position: INPUT_TARGET });
    await sleep(1_200 + (index % 3) * 200);
  }
  await sleep(1_500);
  await handle.stop();
  const label = `input-${mode}-${viewer.name}`;
  const received = await decodeMarkers(host, options.out, label, handle.events);
  const latencies: Array<number> = [];
  let missed = 0;
  for (const send of sends) {
    const shown = received.find(
      (frame) => frame.at >= send.at && frame.marker !== null && frame.marker >= send.marker,
    );
    if (shown === undefined) missed += 1;
    else latencies.push(shown.at - send.at);
  }
  NodeFS.writeFileSync(
    NodePath.join(options.out, "samples", `${label}.json`),
    JSON.stringify({ sends, received, latencies }),
  );
  return { mode, viewer: viewer.name, inputToReceived: summarize(latencies), missed };
}

async function measureFirstFrame(
  host: HostProcess,
  options: Options,
  url: string,
  mode: Mode,
  viewer: ViewerSize,
) {
  await host.call("scene", { name: "idle" });
  const samples: Array<number> = [];
  for (let run = 0; run < options.firstFrameRuns; run++) {
    const openedAt = now();
    const handle = await startViewer(mode, url, viewer);
    const firstAt = await waitWithTimeout(handle.firstPictureAt, 10_000, null);
    await handle.stop();
    if (firstAt === null) throw new Error("Viewer produced no first picture within 10 seconds");
    samples.push(firstAt - openedAt);
    // Let the host notice nobody is watching before the next cold open.
    await sleep(1_000);
  }
  return { mode, viewer: viewer.name, timeToFirstFrame: summarize(samples) };
}

// ---------------------------------------------------------------------------

const fmt = (value: number | null | undefined, digits = 0) =>
  value === null || value === undefined ? "–" : value.toFixed(digits);

function writeReport(options: Options, results: Record<string, unknown>) {
  NodeFS.writeFileSync(
    NodePath.join(options.out, "results.json"),
    JSON.stringify(results, null, 2),
  );
  const scenes = results.scenes as ReadonlyArray<SceneResult>;
  const lines = [
    "# Remote preview bench",
    "",
    `Run: ${new Date().toISOString()}  ·  ${options.seconds} s steady state per scene  ·  modes: ${options.modes.join(", ")}`,
    "",
    "Produced by `node scripts/remote-preview-bench/run.ts`. Latency is measured on pixels: every scene",
    "page draws a counter marker, records when it changed it, and the bench decodes the marker out of",
    "every picture the viewer received. Timestamps are network receipt, before viewer decoding or display.",
    "Superseded changes count when a newer marker arrives; missing changes are reported, not discarded.",
    "Bytes are read off the viewer's TCP socket (after",
    "permessage-deflate, with WebSocket framing). TLS, TCP/IP headers and retransmissions are excluded.",
    "The source is a real Electron webview. Image modes use a Node RPC receiver with offline pixel decoding.",
    "Old polling modes have one shared-node baseline per condition, used for both viewport comparisons.",
    "They are measured once and never duplicated as an independent desktop measurement.",
    "new-video uses the production preview media broker, tab capture, publisher and subscriber, with a",
    "WebKit phone viewport and an Electron desktop viewer. These are host browsers, not a physical phone.",
    "Video receipt timestamps are joined to decoded markers by the original packet timestamp; changeToDecoded",
    "is reported separately and excludes physical display scanout. Media and RPC bytes pass through a TCP meter;",
    "benchmark page assets use a separate unshaped port. New image mode imports the production encoder, streamer, pacer and relay.",
    "The encoder runs in a separate renderer through an IPC adapter instead of the app worker.",
    "",
    "## Change-to-received and bandwidth per scene",
    "",
    "| scene | viewer | mode | change→received p50 ms | p95 ms | n | missed | down B/s | up B/s | MB/hour | pictures |",
    "|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|",
    ...scenes.map(
      (row) =>
        `| ${row.scene} | ${row.viewer} | ${row.mode} | ${fmt(row.changeToReceived.p50)} | ${fmt(row.changeToReceived.p95)} | ${row.changeToReceived.count} | ${row.missed} | ${fmt(row.bytesReadPerSecond)} | ${fmt(row.bytesWrittenPerSecond)} | ${fmt(row.megabytesPerHour, 1)} | ${row.pictures} |`,
    ),
    "",
    "## Input-to-received",
    "",
    "| viewer | mode | p50 ms | p95 ms | n | missed |",
    "|---|---|---:|---:|---:|---:|",
    ...(
      results.input as ReadonlyArray<{
        mode: string;
        viewer: string;
        inputToReceived: LatencySummary;
        missed: number;
      }>
    ).map(
      (row) =>
        `| ${row.viewer} | ${row.mode} | ${fmt(row.inputToReceived.p50)} | ${fmt(row.inputToReceived.p95)} | ${row.inputToReceived.count} | ${row.missed} |`,
    ),
    "",
    "## Time to first frame",
    "",
    "| viewer | mode | p50 ms | p95 ms | n |",
    "|---|---|---:|---:|---:|",
    ...(
      results.firstFrame as ReadonlyArray<{
        mode: string;
        viewer: string;
        timeToFirstFrame: LatencySummary;
      }>
    ).map(
      (row) =>
        `| ${row.viewer} | ${row.mode} | ${fmt(row.timeToFirstFrame.p50)} | ${fmt(row.timeToFirstFrame.p95)} | ${row.timeToFirstFrame.count} |`,
    ),
    "",
  ];
  const slow = results.slowLink as ReadonlyArray<SceneResult> | undefined;
  if (slow && slow.length > 0) {
    lines.push(
      "## Slow link (1.5 Mbit/s, 40 ms each way, 256 KB queue), phone request and shared Node baseline",
      "",
      "| scene | mode | change→received p50 ms | p95 ms | max ms | n | missed | down B/s |",
      "|---|---|---:|---:|---:|---:|---:|---:|",
      ...slow.map(
        (row) =>
          `| ${row.scene} | ${row.mode} | ${fmt(row.changeToReceived.p50)} | ${fmt(row.changeToReceived.p95)} | ${fmt(row.changeToReceived.max)} | ${row.changeToReceived.count} | ${row.missed} | ${fmt(row.bytesReadPerSecond)} |`,
      ),
      "",
    );
  }
  lines.push(
    "Files: `results.json` (everything above), `samples/*.json` (per-run marks, decoded markers, latencies),",
    "`electron-host.log` (the desktop host's stderr).",
    "",
  );
  NodeFS.writeFileSync(NodePath.join(options.out, "README.md"), lines.join("\n"));
  return lines.join("\n");
}

export async function buildRenderer(out: string) {
  const { build } = await import("vite-plus");
  await build({
    configFile: false,
    logLevel: "warn",
    root: here,
    build: {
      outDir: NodePath.join(out, "renderer"),
      emptyOutDir: true,
      minify: false,
      lib: {
        entry: NodePath.join(here, "encoder-renderer.ts"),
        formats: ["iife"],
        name: "PreviewBench",
        fileName: () => "encoder.js",
      },
    },
  });
}

async function main() {
  const options = parseOptions();
  NodeFS.mkdirSync(NodePath.join(options.out, "frames"), { recursive: true });
  NodeFS.mkdirSync(NodePath.join(options.out, "samples"), { recursive: true });
  console.log(`remote preview bench -> ${options.out}`);
  await buildRenderer(options.out);
  if (options.buildOnly) {
    console.log("Preview benchmark renderer built; no processes launched.");
    return;
  }
  const server = await Effect.runPromise(startRelayServer());
  const url = `ws://127.0.0.1:${server.port}/ws`;
  let host: HostProcess | null = null;
  try {
    host = await startHost(options.out);
    await host.call("connect", { url, environmentId: BENCH_ENVIRONMENT_ID });
    if (options.modes.includes("new-video"))
      videoViewerDriver = await createVideoViewerDriver({
        host,
        out: options.out,
        images: options.images,
      });
    const scenes: Array<SceneResult> = [];
    for (const scene of options.scenes) {
      for (const mode of options.modes) {
        const viewers = mode.startsWith("new") ? VIEWERS : [SHARED_NODE_VIEWER];
        for (const viewer of viewers) {
          const result = await measureScene(host, options, url, scene, mode, viewer);
          console.log(
            `${scene} ${mode} ${viewer.name}: p50 ${fmt(result.changeToReceived.p50)} ms p95 ${fmt(result.changeToReceived.p95)} ms, ${fmt(result.bytesReadPerSecond)} B/s down`,
          );
          scenes.push(result);
        }
      }
    }
    const input = [];
    const firstFrame = [];
    for (const mode of options.modes) {
      for (const viewer of mode.startsWith("new") ? VIEWERS : [SHARED_NODE_VIEWER]) {
        const inputResult = await measureInput(host, options, url, mode, viewer);
        console.log(`input ${mode} ${viewer.name}: p50 ${fmt(inputResult.inputToReceived.p50)} ms`);
        input.push(inputResult);
        const first = await measureFirstFrame(host, options, url, mode, viewer);
        console.log(
          `first frame ${mode} ${viewer.name}: p50 ${fmt(first.timeToFirstFrame.p50)} ms`,
        );
        firstFrame.push(first);
      }
    }
    const slowLink: Array<SceneResult> = [];
    if (options.slowLink) {
      const proxy = await startThrottleProxy(server.port, {
        bytesPerSecond: 1_500_000 / 8,
        delayMs: 40,
        queueBytes: 256 * 1024,
      });
      try {
        const slowUrl = `ws://127.0.0.1:${proxy.port}/ws`;
        for (const scene of ["ticks", "scroll"]) {
          for (const mode of options.modes) {
            const result = await measureScene(
              host,
              options,
              slowUrl,
              scene,
              mode,
              mode.startsWith("new") ? VIEWERS[0]! : SHARED_NODE_VIEWER,
              "slow",
            );
            console.log(
              `slow ${scene} ${mode}: p50 ${fmt(result.changeToReceived.p50)} ms p95 ${fmt(result.changeToReceived.p95)} ms max ${fmt(result.changeToReceived.max)} ms`,
            );
            slowLink.push({ ...result, scene: `${scene} (slow link)` });
          }
        }
      } finally {
        await proxy.close();
      }
    }
    const report = writeReport(options, { options, scenes, input, firstFrame, slowLink });
    console.log(report);
  } finally {
    try {
      try {
        const cleanup = await Promise.allSettled([...activeViewers].map((viewer) => viewer.stop()));
        for (const result of cleanup)
          if (result.status === "rejected") console.error("Viewer cleanup failed", result.reason);
      } finally {
        try {
          await videoViewerDriver?.close();
        } finally {
          await host?.close();
        }
      }
    } finally {
      await Effect.runPromise(server.close);
    }
  }
}

if (process.argv[1] && NodePath.resolve(process.argv[1]) === NodeURL.fileURLToPath(import.meta.url))
  await main();
