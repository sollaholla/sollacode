// @effect-diagnostics nodeBuiltinImport:off - A plain loopback HTTP server for the browser panel.
// @effect-diagnostics globalDate:off - Frame reuse window between concurrent viewers.
import * as NodeCrypto from "node:crypto";
import * as NodeHttp from "node:http";
import type * as NodeNet from "node:net";

/** Hardware and navigation keys, with their adb key codes. */
export const ANDROID_KEYS = {
  back: { keyCode: 4 },
  home: { keyCode: 3 },
  recents: { keyCode: 187 },
  enter: { keyCode: 66 },
  backspace: { keyCode: 67 },
  tab: { keyCode: 61 },
  escape: { keyCode: 111 },
  up: { keyCode: 19 },
  down: { keyCode: 20 },
  left: { keyCode: 21 },
  right: { keyCode: 22 },
  power: { keyCode: 26 },
  volumeUp: { keyCode: 24 },
  volumeDown: { keyCode: 25 },
} as const;
export type AndroidKey = keyof typeof ANDROID_KEYS | "rotate";

/** One input event from the viewer. Points are fractions (0-1) of the picture shown. */
export type AndroidViewerInput =
  | {
      readonly kind: "touch";
      readonly phase: "down" | "move" | "up";
      readonly x: number;
      readonly y: number;
    }
  | {
      readonly kind: "swipe";
      readonly x1: number;
      readonly y1: number;
      readonly x2: number;
      readonly y2: number;
      readonly durationMs: number;
    }
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "key"; readonly key: AndroidKey };

/** A running emulator's screen. */
export interface AndroidScreen {
  /** A PNG of the current screen, at most `maxWidth` pixels wide when the emulator can scale. */
  readonly capture: (maxWidth: number) => Promise<Buffer>;
  readonly input: (event: AndroidViewerInput) => Promise<void>;
}

export interface AndroidViewerBackend {
  /** The emulator's screen, or null when that AVD isn't running. */
  readonly screenFor: (avdName: string) => Promise<AndroidScreen | null>;
}

export interface AndroidViewer {
  readonly urlFor: (avdName: string) => string;
  readonly close: () => Promise<void>;
}

const MAX_INPUT_BYTES = 8 * 1024;
const MAX_TEXT_LENGTH = 1_000;
const DEFAULT_FRAME_WIDTH = 720;
const MAX_FRAME_WIDTH = 2_000;
// A frame this fresh is shared with every viewer polling the same emulator.
const FRAME_REUSE_MS = 40;

function fraction(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1
    ? value
    : null;
}

/** Validates a POSTed input event; anything malformed is dropped. */
export function parseAndroidViewerInput(value: unknown): AndroidViewerInput | null {
  if (typeof value !== "object" || value === null) return null;
  const input = value as Record<string, unknown>;
  switch (input.kind) {
    case "touch": {
      const x = fraction(input.x);
      const y = fraction(input.y);
      const phase = input.phase;
      if (x === null || y === null) return null;
      return phase === "down" || phase === "move" || phase === "up"
        ? { kind: "touch", phase, x, y }
        : null;
    }
    case "swipe": {
      const points = [input.x1, input.y1, input.x2, input.y2].map(fraction);
      const durationMs = input.durationMs;
      if (points.some((point) => point === null) || typeof durationMs !== "number") return null;
      const [x1, y1, x2, y2] = points as [number, number, number, number];
      return {
        kind: "swipe",
        x1,
        y1,
        x2,
        y2,
        durationMs: Math.round(Math.min(2_000, Math.max(50, durationMs))),
      };
    }
    case "text":
      return typeof input.text === "string" &&
        input.text.length > 0 &&
        input.text.length <= MAX_TEXT_LENGTH
        ? { kind: "text", text: input.text }
        : null;
    case "key":
      return typeof input.key === "string" &&
        (input.key === "rotate" || Object.hasOwn(ANDROID_KEYS, input.key))
        ? { kind: "key", key: input.key as AndroidKey }
        : null;
    default:
      return null;
  }
}

/**
 * `adb shell input text` runs through the device's shell: quote for `sh`,
 * and spell spaces as `%s`, which is how `input` reads a space.
 */
export function quoteAndroidInputText(text: string): string {
  const printable = [...text].filter((character) => character >= " " && character !== "\u007f");
  return `'${printable.join("").replaceAll(" ", "%s").replaceAll("'", "'\\''")}'`;
}

/** Width and height from a PNG's IHDR chunk. */
export function pngSize(png: Buffer): { width: number; height: number } | null {
  if (png.length < 24 || png.readUInt32BE(0) !== 0x89504e47) return null;
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

interface CachedFrame {
  readonly png: Buffer;
  readonly etag: string;
  readonly at: number;
}

/**
 * A loopback-only page that shows one emulator's screen and sends input back.
 * Every URL carries a random token, so other local pages and other users on
 * the machine can't drive the emulator.
 */
export async function startAndroidViewer(backend: AndroidViewerBackend): Promise<AndroidViewer> {
  const token = NodeCrypto.randomBytes(24).toString("base64url");
  const latest = new Map<string, CachedFrame>();
  const inflight = new Map<string, Promise<CachedFrame>>();

  const frameFor = (avdName: string, screen: AndroidScreen, width: number) => {
    const key = `${avdName}@${width}`;
    const cached = latest.get(key);
    if (cached && Date.now() - cached.at < FRAME_REUSE_MS) return Promise.resolve(cached);
    const running = inflight.get(key);
    if (running) return running;
    const next = screen
      .capture(width)
      .then((png) => {
        const frame = {
          png,
          etag: NodeCrypto.createHash("sha1").update(png).digest("base64url"),
          at: Date.now(),
        };
        latest.set(key, frame);
        return frame;
      })
      .finally(() => inflight.delete(key));
    inflight.set(key, next);
    return next;
  };

  const handle = async (request: NodeHttp.IncomingMessage, response: NodeHttp.ServerResponse) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const [requestToken, encodedName, action = ""] = url.pathname.split("/").slice(1);
    if (requestToken !== token || !encodedName) {
      response.writeHead(404).end();
      return;
    }
    const avdName = decodeURIComponent(encodedName);
    response.setHeader("Cache-Control", "no-store");

    if (request.method === "GET" && action === "") {
      response.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Security-Policy":
          "default-src 'none'; img-src blob:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'",
      });
      response.end(viewerHtml(avdName));
      return;
    }

    const screen = await backend.screenFor(avdName);
    if (screen === null) {
      response.writeHead(503, { "Content-Type": "text/plain" }).end("off");
      return;
    }

    if (request.method === "GET" && action === "frame") {
      const requested = Number(url.searchParams.get("w"));
      const width =
        Number.isFinite(requested) && requested > 0
          ? Math.min(MAX_FRAME_WIDTH, Math.round(requested))
          : DEFAULT_FRAME_WIDTH;
      const frame = await frameFor(avdName, screen, width).catch(() => null);
      if (frame === null) {
        response.writeHead(503, { "Content-Type": "text/plain" }).end("starting");
        return;
      }
      // "Unchanged" is a plain 204 rather than a 304: browsers log a 304 to a
      // request they never cached as a failed load.
      if (url.searchParams.get("known") === frame.etag) {
        response.writeHead(204).end();
        return;
      }
      response.writeHead(200, { "Content-Type": "image/png", "X-Frame-Id": frame.etag });
      response.end(frame.png);
      return;
    }

    if (request.method === "POST" && action === "input") {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of request) {
        size += (chunk as Buffer).length;
        if (size > MAX_INPUT_BYTES) {
          response.writeHead(413).end();
          return;
        }
        chunks.push(chunk as Buffer);
      }
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        parsed = null;
      }
      const input = parseAndroidViewerInput(parsed);
      if (input === null) {
        response.writeHead(400).end();
        return;
      }
      await screen.input(input);
      for (const key of latest.keys()) if (key.startsWith(`${avdName}@`)) latest.delete(key);
      response.writeHead(204).end();
      return;
    }

    response.writeHead(404).end();
  };

  const server = NodeHttp.createServer((request, response) => {
    void handle(request, response).catch(() => {
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const { port } = server.address() as NodeNet.AddressInfo;

  return {
    urlFor: (avdName) => `http://127.0.0.1:${port}/${token}/${encodeURIComponent(avdName)}/`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/gu,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!,
  );
}

const ICONS = {
  back: '<path d="M15 6 9 12l6 6"/>',
  home: '<circle cx="12" cy="12" r="6"/>',
  recents: '<rect x="6.5" y="6.5" width="11" height="11" rx="2"/>',
  rotate: '<path d="M4 12a8 8 0 0 1 13.7-5.6L20 8.5"/><path d="M20 4v4.5h-4.5"/>',
  volumeDown: '<path d="M4 9.5h3l4-3.5v12l-4-3.5H4z"/><path d="M15 12h5"/>',
  volumeUp: '<path d="M4 9.5h3l4-3.5v12l-4-3.5H4z"/><path d="M15 12h5M17.5 9.5v5"/>',
  power: '<path d="M12 4v7"/><path d="M7.5 7.2a7 7 0 1 0 9 0"/>',
};

function toolbarButton(key: keyof typeof ICONS, label: string): string {
  return `<button type="button" data-key="${key}" title="${label}" aria-label="${label}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${ICONS[key]}</svg></button>`;
}

function viewerHtml(avdName: string): string {
  const title = escapeHtml(avdName.replaceAll("_", " "));
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  html, body { margin: 0; height: 100%; background: #0b0b0c; color: #e7e7e9; font: 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  body { display: flex; flex-direction: column; overflow: hidden; user-select: none; -webkit-user-select: none; }
  main { position: relative; flex: 1; min-height: 0; display: flex; align-items: center; justify-content: center; padding: 16px 16px 4px; }
  img { max-width: 100%; max-height: 100%; border-radius: 18px; box-shadow: 0 0 0 1px rgba(255,255,255,.08), 0 18px 50px rgba(0,0,0,.45); touch-action: none; -webkit-user-drag: none; }
  img[hidden] { display: none; }
  #status { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; padding: 24px; text-align: center; color: #9a9aa2; pointer-events: none; }
  #status[hidden] { display: none; }
  nav { display: flex; justify-content: center; gap: 4px; padding: 6px 12px 12px; }
  button { width: 38px; height: 34px; display: inline-flex; align-items: center; justify-content: center; border: 0; border-radius: 10px; background: transparent; color: #c9c9cf; cursor: pointer; }
  button:hover { background: rgba(255,255,255,.08); color: #fff; }
  button:focus-visible { outline: 2px solid #d4b45c; outline-offset: 1px; }
  button svg { width: 20px; height: 20px; }
  .gap { width: 14px; }
</style></head>
<body>
<main><img id="screen" alt="${title} screen" hidden draggable="false"><div id="status">Connecting to ${title}…</div></main>
<nav aria-label="Device buttons">
${toolbarButton("back", "Back")}${toolbarButton("home", "Home")}${toolbarButton("recents", "Recent apps")}
<span class="gap"></span>
${toolbarButton("rotate", "Rotate")}${toolbarButton("volumeDown", "Volume down")}${toolbarButton("volumeUp", "Volume up")}${toolbarButton("power", "Power")}
</nav>
<script>
(() => {
  const screen = document.getElementById("screen");
  const status = document.getElementById("status");
  let etag = null, wake = null, objectUrl = null, quietSince = performance.now();

  const sleep = (ms) => new Promise((resolve) => { const id = setTimeout(() => { wake = null; resolve(); }, ms); wake = () => { clearTimeout(id); wake = null; resolve(); }; });
  const nudge = () => { quietSince = performance.now(); if (wake) wake(); };
  const showStatus = (text) => { status.textContent = text; status.hidden = false; screen.hidden = true; etag = null; };
  const main = document.querySelector("main");
  // Sized from the space available, not the picture, so a wider panel gets a sharper frame.
  const frameWidth = () => {
    const style = getComputedStyle(main);
    const width = main.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    const height = main.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
    const aspect = screen.naturalWidth ? screen.naturalHeight / screen.naturalWidth : 2.2;
    return Math.round(Math.min(2000, Math.max(240, Math.min(width, height / aspect) * (window.devicePixelRatio || 1))));
  };

  // Fast while the screen changes, then slower the longer it stays still.
  async function loop() {
    for (;;) {
      if (document.hidden) { await new Promise((r) => document.addEventListener("visibilitychange", r, { once: true })); continue; }
      let wait;
      try {
        const response = await fetch("frame?w=" + frameWidth() + (etag ? "&known=" + encodeURIComponent(etag) : ""));
        // Every body is read to the end, even an empty one: an unread response
        // shows up as a failed request in the browser's network log.
        const body = await response.arrayBuffer();
        if (response.status === 200) {
          const blob = new Blob([body], { type: "image/png" });
          etag = response.headers.get("X-Frame-Id");
          const next = URL.createObjectURL(blob);
          await new Promise((resolve) => { screen.onload = resolve; screen.onerror = resolve; screen.src = next; });
          if (objectUrl) URL.revokeObjectURL(objectUrl);
          objectUrl = next;
          screen.hidden = false; status.hidden = true;
          quietSince = performance.now();
          wait = 33;
        } else if (response.status === 204) {
          const quiet = performance.now() - quietSince;
          wait = quiet < 2000 ? 66 : quiet < 30000 ? 250 : 1000;
        } else if (response.status === 503) {
          showStatus(new TextDecoder().decode(body) === "off" ? "This emulator is off. Start it from Settings → Devices." : "Starting Android…");
          wait = 1500;
        } else {
          wait = 1500;
        }
      } catch { showStatus("Lost connection to Solla Code. Retrying…"); wait = 2000; }
      await sleep(wait);
    }
  }

  // Input is delivered in order; consecutive finger moves collapse to the latest.
  const queue = [];
  let sending = false;
  async function pump() {
    if (sending) return;
    sending = true;
    while (queue.length) {
      const input = queue.shift();
      try { await (await fetch("input", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) })).arrayBuffer(); } catch {}
      nudge();
    }
    sending = false;
  }
  function send(input) {
    const last = queue[queue.length - 1];
    if (input.kind === "touch" && input.phase === "move" && last && last.kind === "touch" && last.phase === "move") queue[queue.length - 1] = input;
    else queue.push(input);
    pump();
  }

  const toFraction = (event) => {
    const rect = screen.getBoundingClientRect();
    return {
      x: Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)),
      y: Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height)),
    };
  };

  let pressed = false;
  screen.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    screen.setPointerCapture(event.pointerId);
    pressed = true;
    send({ kind: "touch", phase: "down", ...toFraction(event) });
  });
  screen.addEventListener("pointermove", (event) => {
    if (pressed) send({ kind: "touch", phase: "move", ...toFraction(event) });
  });
  const release = (event) => {
    if (!pressed) return;
    pressed = false;
    send({ kind: "touch", phase: "up", ...toFraction(event) });
  };
  screen.addEventListener("pointerup", release);
  screen.addEventListener("pointercancel", release);

  let wheel = null;
  screen.addEventListener("wheel", (event) => {
    event.preventDefault();
    if (!wheel) {
      const start = toFraction(event);
      const rect = screen.getBoundingClientRect();
      wheel = { start, dx: 0, dy: 0, width: rect.width, height: rect.height };
      setTimeout(() => {
        const w = wheel; wheel = null;
        const clamp = (v) => Math.min(0.98, Math.max(0.02, v));
        const dx = Math.max(-0.6, Math.min(0.6, w.dx / w.width)), dy = Math.max(-0.6, Math.min(0.6, w.dy / w.height));
        send({ kind: "swipe", x1: w.start.x, y1: w.start.y, x2: clamp(w.start.x - dx), y2: clamp(w.start.y - dy), durationMs: 160 });
      }, 100);
    }
    wheel.dx += event.deltaX; wheel.dy += event.deltaY;
  }, { passive: false });

  let typed = "", typeTimer = null;
  const flushText = () => { clearTimeout(typeTimer); typeTimer = null; if (typed) { const text = typed; typed = ""; send({ kind: "text", text }); } };
  const KEYS = { Enter: "enter", Backspace: "backspace", Tab: "tab", Escape: "escape", ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right" };
  window.addEventListener("keydown", (event) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key.length === 1) {
      event.preventDefault();
      typed += event.key;
      clearTimeout(typeTimer); typeTimer = setTimeout(flushText, 120);
    } else if (KEYS[event.key]) {
      event.preventDefault();
      flushText();
      send({ kind: "key", key: KEYS[event.key] });
    }
  });
  window.addEventListener("paste", (event) => {
    const text = event.clipboardData && event.clipboardData.getData("text");
    if (text) { event.preventDefault(); flushText(); send({ kind: "text", text: text.slice(0, 1000) }); }
  });

  for (const button of document.querySelectorAll("button[data-key]")) {
    button.addEventListener("click", () => send({ kind: "key", key: button.dataset.key }));
  }

  loop();
})();
</script>
</body></html>`;
}
