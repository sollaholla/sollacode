// The desktop side of the remote preview bench, run by the repo's own Electron
// with a throwaway profile and no visible window. It renders a scene in a
// <webview> guest (like the app's browser panel) and connects to the bench
// server as a preview automation host, answering the same requests the app's
// desktop host answers. The orchestrator drives it over stdin/stdout.
import * as NodeFS from "node:fs";
import * as NodeReadline from "node:readline";

import { app, BrowserWindow, nativeImage, webContents } from "electron";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import { connectBenchClient } from "./benchClient.ts";
import { createRemoteFrameStreamer } from "../../apps/web/src/components/preview/remoteFrames/remoteFrameStreamer.ts";
import {
  createScreencastPacer,
  REMOTE_FRAME_MIN_INTERVAL_MS,
  REMOTE_FRAME_SETTLE_MS,
  REMOTE_FRAME_SCREENCAST_QUALITY,
} from "../../apps/desktop/src/preview/remoteFrameScreencast.ts";
import { SCENE_VIEWPORT, SCENES, readMarker } from "./scenes.mjs";

const PROTOCOL_PREFIX = "@@RP ";
const OLD_JPEG_QUALITY = 78;
const OLD_MAX_WIDTH = 1024;

app.commandLine.appendSwitch("force-device-scale-factor", "2");
app.setActivationPolicy?.("accessory");
app.dock?.hide();

const send = (message) => process.stdout.write(`${PROTOCOL_PREFIX}${JSON.stringify(message)}\n`);
const log = (...args) => process.stderr.write(`[host] ${args.join(" ")}\n`);

/** @type {Electron.WebContents | null} */
let guest = null;
/** @type {Awaited<ReturnType<typeof Effect.runPromise>> | null} */
let bench = null;
let hostClientId = `bench-host-${process.pid}`;
let connectionId = null;
let notifyConnected = () => {};
let threadId = "bench-thread";
let tabId = "bench-tab";
let encoderWindow = null;
let streamer = null;
let pacer = null;
let pageState = null;
let captureFrames = 0;
let encodeCalls = 0;
let publishedPictures = 0;
const encoderCall = (method, ...args) =>
  encoderWindow.webContents.executeJavaScript(
    `previewBenchEncoder.${method}(...${JSON.stringify(args)})`,
  );

async function stopCapture() {
  pacer?.dispose();
  pacer = null;
  await cdp("Page.stopScreencast");
}

async function startCapture(_tabId, size) {
  await stopCapture();
  pacer = createScreencastPacer({
    minIntervalMs: REMOTE_FRAME_MIN_INTERVAL_MS,
    settleMs: REMOTE_FRAME_SETTLE_MS,
    now: () => performance.now(),
    setTimer: (run, ms) => {
      const id = setTimeout(run, ms);
      return () => clearTimeout(id);
    },
    ack: (sessionId) => {
      void cdp("Page.screencastFrameAck", { sessionId }).catch(log);
    },
    refresh: () => guest.invalidate(),
  });
  await cdp("Page.startScreencast", {
    format: "jpeg",
    quality: REMOTE_FRAME_SCREENCAST_QUALITY,
    maxWidth: size.maxWidth,
    maxHeight: size.maxHeight,
    everyNthFrame: 1,
  });
  guest.invalidate();
}

function createStreamer() {
  streamer = createRemoteFrameStreamer({
    runtimeTabId: () => tabId,
    capture: { start: startCapture, stop: stopCapture, refresh: async () => guest.invalidate() },
    encoder: {
      encode: (key, input) => {
        encodeCalls++;
        return encoderCall("encode", key, input);
      },
      reset: (key) => {
        void encoderCall("reset", key).catch(log);
      },
      drop: (key) => {
        void encoderCall("drop", key).catch(log);
      },
    },
    publish: async (target, events) => {
      publishedPictures += events.filter(
        (event) => event.type === "keyframe" || event.type === "patch",
      ).length;
      await Effect.runPromise(
        bench.client["preview.remoteFramePublish"]({ ...target, connectionId, events }),
      );
    },
    readState: () => pageState,
    scheduler: {
      now: () => performance.now(),
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    },
    onError: (error) => log("streamer", String(error)),
  });
  guest.debugger.on("message", (_event, method, params) => {
    if (method !== "Page.screencastFrame") return;
    captureFrames++;
    streamer.frameArrived({ tabId, data: params.data });
    if (pacer) pacer.onFrame(params.sessionId);
    else void cdp("Page.screencastFrameAck", { sessionId: params.sessionId }).catch(log);
  });
}

const cdp = (method, params) => guest.debugger.sendCommand(method, params);

// Roughly what the app's readPage evaluates on every agent snapshot: the
// visible text and every interactive element with its box.
const READ_PAGE = `(() => {
  const elements = Array.from(document.querySelectorAll("a,button,input,textarea,select,[role],[tabindex]")).slice(0, 200).map((element) => {
    const rect = element.getBoundingClientRect();
    return { tag: element.tagName.toLowerCase(), role: element.getAttribute("role"), name: element.getAttribute("aria-label") || (element.innerText || "").slice(0, 80), x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  });
  return { url: location.href, title: document.title, loading: document.readyState !== "complete", visibleText: (document.body?.innerText || "").slice(0, 20000), interactiveElements: elements, viewportWidth: innerWidth, viewportHeight: innerHeight };
})()`;

async function readPage() {
  const result = await cdp("Runtime.evaluate", { expression: READ_PAGE, returnByValue: true });
  return result.result.value;
}

/**
 * The app's snapshot for a remote viewer (Manager.captureAutomationSnapshot):
 * read the page, capture a JPEG from the surface, shrink anything wider than
 * 1024 px, read the accessibility tree, and read the page again. It does not
 * repeat the app's per-poll foreground renewal or background staging, so the
 * old path measured here is slightly faster than the app's.
 */
async function oldSnapshot() {
  const opening = await readPage();
  const shot = await cdp("Page.captureScreenshot", {
    format: "jpeg",
    quality: OLD_JPEG_QUALITY,
    fromSurface: true,
    captureBeyondViewport: false,
  });
  let data = shot.data;
  let image = nativeImage.createFromBuffer(Buffer.from(data, "base64"));
  let size = image.getSize();
  if (size.width > OLD_MAX_WIDTH) {
    image = image.resize({ width: OLD_MAX_WIDTH });
    size = image.getSize();
    data = image.toJPEG(OLD_JPEG_QUALITY).toString("base64");
  }
  await cdp("Page.getFrameTree");
  const tree = await cdp("Accessibility.getFullAXTree");
  const closing = await readPage();
  return {
    url: closing.url,
    title: closing.title,
    loading: closing.loading || opening.loading,
    visibleText: closing.visibleText,
    interactiveElements: [],
    accessibilityTree: { nodes: tree.nodes.slice(0, 500) },
    consoleEntries: [],
    networkEntries: [],
    actionTimeline: [],
    pendingDownloadApprovals: [],
    tabId,
    screenshot: { mimeType: "image/jpeg", data, width: size.width, height: size.height },
  };
}

async function status() {
  const page = await readPage();
  return {
    available: true,
    visible: false,
    tabId,
    url: page.url,
    title: page.title,
    loading: page.loading,
    viewport: { width: page.viewportWidth, height: page.viewportHeight },
  };
}

async function click(input) {
  const base = { x: input.x, y: input.y, button: "left", clickCount: 1 };
  await cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x: input.x, y: input.y });
  await cdp("Input.dispatchMouseEvent", { type: "mousePressed", ...base });
  await cdp("Input.dispatchMouseEvent", { type: "mouseReleased", ...base });
}

async function handleRequest(request) {
  switch (request.operation) {
    case "snapshot":
      return oldSnapshot();
    case "status":
      return status();
    case "click":
      await click(request.input);
      return { tabId };
    case "scroll":
      await cdp("Input.dispatchMouseEvent", {
        type: "mouseWheel",
        x: request.input.x ?? SCENE_VIEWPORT.width / 2,
        y: request.input.y ?? SCENE_VIEWPORT.height / 2,
        deltaX: request.input.deltaX,
        deltaY: request.input.deltaY,
      });
      return { tabId };
    case "type":
      await cdp("Input.insertText", { text: request.input.text });
      return { tabId };
    default:
      throw new Error(`The bench host does not implement ${request.operation}.`);
  }
}

function respond(event, outcome) {
  return Effect.runPromise(
    bench.client["previewAutomation.respond"]({
      clientId: hostClientId,
      connectionId: event.connectionId,
      requestId: event.request.requestId,
      ...outcome,
    }),
  ).catch((error) => log("respond failed", String(error)));
}

function onHostEvent(event) {
  if (event.type === "connected") {
    connectionId = event.connectionId;
    notifyConnected();
    return;
  }
  if (event.type === "frameDemand") {
    streamer.setDemand(event.tabs);
    return;
  }
  if (event.type === "request") {
    handleRequest(event.request).then(
      (result) => respond(event, { ok: true, result }),
      (error) =>
        respond(event, {
          ok: false,
          error: { _tag: "PreviewAutomationExecutionError", message: String(error) },
        }),
    );
  }
}

async function connect({ url, environmentId }) {
  bench = await Effect.runPromise(connectBenchClient(url));
  const host = {
    clientId: hostClientId,
    environmentId,
    supportedOperations: ["status", "snapshot", "click", "scroll", "type", "press"],
    environmentLocal: true,
    streamsRemoteFrames: true,
  };
  const ready = new Promise((resolve) => {
    notifyConnected = resolve;
  });
  Effect.runFork(
    Stream.runForEach(bench.client["previewAutomation.connect"](host), (event) =>
      Effect.sync(() => onHostEvent(event)),
    ).pipe(Effect.tapCause((cause) => Effect.sync(() => log("host stream ended", String(cause))))),
  );
  let timer;
  try {
    await Promise.race([
      ready,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("The bench server never confirmed the host.")),
          10_000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
  return { connectionId };
}

async function loadScene({ name }) {
  const html = SCENES[name]?.();
  if (!html) throw new Error(`Unknown scene ${name}`);
  await guest.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  await cdp("Emulation.setFocusEmulationEnabled", { enabled: true });
  await new Promise((resolve) => setTimeout(resolve, 500));
  const state = await status();
  pageState = { url: state.url, title: state.title, loading: false, pendingDownloadApprovals: [] };
  streamer.stateChanged(tabId);
  captureFrames = 0;
  encodeCalls = 0;
  publishedPictures = 0;
  return {
    viewport: await guest.executeJavaScript("({ width: innerWidth, height: innerHeight })"),
  };
}

/** Bitmap of a JPEG, plus a luminance reader for the marker. */
function decodeJpeg(base64) {
  const image = nativeImage.createFromBuffer(Buffer.from(base64, "base64"));
  const size = image.getSize();
  return { size, bitmap: image.toBitmap() };
}

function luminanceReader(bitmap, width) {
  return (x, y) => {
    const offset = (y * width + x) * 4;
    return (bitmap[offset] + bitmap[offset + 1] + bitmap[offset + 2]) / 3;
  };
}

/**
 * Reads the marker out of every picture a viewer received. Whole frames are
 * decoded on their own; patches are drawn over the picture they apply to,
 * exactly as a viewer composes them.
 */
function decodeFrames({ input, output }) {
  const lines = NodeFS.readFileSync(input, "utf8").split("\n").filter(Boolean);
  const results = [];
  let composite = null;
  let markerValue = null;
  for (const line of lines) {
    const event = JSON.parse(line);
    if (event.kind === "full") {
      const decoded = decodeJpeg(event.data);
      composite = {
        width: decoded.size.width,
        height: decoded.size.height,
        bitmap: decoded.bitmap,
      };
    } else if (event.kind === "patch" && composite !== null) {
      for (const patch of event.patches) {
        const decoded = decodeJpeg(patch.data);
        for (let row = 0; row < decoded.size.height; row++) {
          const targetY = patch.y + row;
          if (targetY >= composite.height) break;
          const sourceStart = row * decoded.size.width * 4;
          const width = Math.min(decoded.size.width, composite.width - patch.x);
          decoded.bitmap.copy(
            composite.bitmap,
            (targetY * composite.width + patch.x) * 4,
            sourceStart,
            sourceStart + width * 4,
          );
        }
      }
    }
    if (composite !== null && event.kind !== "same") {
      markerValue = readMarker(luminanceReader(composite.bitmap, composite.width), composite);
    }
    results.push({ at: event.at, marker: markerValue });
  }
  NodeFS.writeFileSync(output, results.map((result) => JSON.stringify(result)).join("\n"));
  return { count: results.length };
}

const operations = {
  connect,
  scene: loadScene,
  marks: () => guest.executeJavaScript("window.__marks"),
  decode: decodeFrames,
  counters: () => ({ captureFrames, encodeCalls, publishedPictures }),
  quit: () => {
    setTimeout(() => app.exit(0), 50);
    return {};
  },
};

app.whenReady().then(async () => {
  const window = new BrowserWindow({
    show: false,
    width: SCENE_VIEWPORT.width,
    height: SCENE_VIEWPORT.height,
    paintWhenInitiallyHidden: true,
    webPreferences: { backgroundThrottling: false, webviewTag: true },
  });
  await window.loadURL(
    `data:text/html,${encodeURIComponent(
      `<body style="margin:0;overflow:hidden"><webview style="position:fixed;inset:0;width:${SCENE_VIEWPORT.width}px;height:${SCENE_VIEWPORT.height}px;display:flex" src="about:blank" webpreferences="backgroundThrottling=false"></webview></body>`,
    )}`,
  );
  for (let attempt = 0; attempt < 200 && guest === null; attempt++) {
    guest =
      webContents.getAllWebContents().find((contents) => contents.getType() === "webview") ?? null;
    if (guest === null) await new Promise((resolve) => setTimeout(resolve, 25));
  }
  if (guest === null) {
    log("no webview guest");
    app.exit(1);
    return;
  }
  guest.debugger.attach("1.3");
  encoderWindow = new BrowserWindow({
    show: false,
    webPreferences: { backgroundThrottling: false },
  });
  await encoderWindow.loadURL("data:text/html,<title>Preview benchmark encoder</title>");
  await encoderWindow.webContents.executeJavaScript(
    NodeFS.readFileSync(process.env.BENCH_ENCODER_SCRIPT, "utf8"),
  );
  createStreamer();
  const lines = NodeReadline.createInterface({ input: process.stdin });
  lines.on("line", async (line) => {
    const message = JSON.parse(line);
    try {
      const result = await operations[message.op](message.args ?? {});
      send({ id: message.id, ok: true, result });
    } catch (error) {
      send({ id: message.id, ok: false, error: String(error?.stack ?? error) });
    }
  });
  lines.on("close", () => app.exit(0));
  send({ ready: true, threadId, tabId });
});
