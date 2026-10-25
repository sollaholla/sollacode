// Scene pages for the remote preview bench. Each page draws a frame marker:
// a row of black/white cells at the top-left that encodes a counter. The page
// records when it changed the counter (`window.__marks`), and the bench reads
// the counter back out of every frame a viewer received, so change-to-received
// latency can be measured from source changes to network arrivals.

/** Guest viewport in CSS pixels; the bench window renders the webview at this size. */
export const SCENE_VIEWPORT = { width: 900, height: 1000 };

/** Marker geometry in CSS pixels. 15 data bits plus one parity bit. */
export const MARKER = { left: 8, top: 8, cell: 16, bits: 16 };

/** Where the input scene's button sits, as fractions of the viewport. */
export const INPUT_TARGET = { x: 0.5, y: 0.5 };

const markerScript = `
  const MARKER_BITS = ${MARKER.bits};
  window.__marks = [];
  window.__marker = 0;
  const cells = [];
  const markerEl = document.createElement("div");
  markerEl.style.cssText = "position:fixed;left:${MARKER.left}px;top:${MARKER.top}px;display:flex;z-index:2147483647;outline:4px solid #fff;background:#fff";
  for (let i = 0; i < MARKER_BITS; i++) {
    const cell = document.createElement("div");
    cell.style.cssText = "width:${MARKER.cell}px;height:${MARKER.cell}px;background:#fff";
    cells.push(cell);
    markerEl.appendChild(cell);
  }
  document.documentElement.appendChild(markerEl);
  window.__setMarker = (value) => {
    window.__marker = value;
    let parity = 0;
    for (let i = 0; i < MARKER_BITS - 1; i++) {
      const bit = (value >> i) & 1;
      parity ^= bit;
      cells[i].style.background = bit ? "#000" : "#fff";
    }
    cells[MARKER_BITS - 1].style.background = parity ? "#000" : "#fff";
    window.__marks.push([value, performance.timeOrigin + performance.now()]);
  };
  window.__setMarker(1);
  window.__tickMarker = () => window.__setMarker(window.__marker + 1);
  // Random 600-900 ms gaps, so ticks never phase-lock with a poll interval.
  window.__startTicks = () => {
    let seed = 12345;
    const random = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const step = () => {
      window.__tickMarker();
      window.__tickTimer = setTimeout(step, 600 + random() * 300);
    };
    window.__tickTimer = setTimeout(step, 600 + random() * 300);
  };
`;

const article = Array.from(
  { length: 40 },
  (_, index) =>
    `<p>Paragraph ${index + 1}. The quick brown fox jumps over the lazy dog while a remote viewer watches every pixel arrive. Solla Code mirrors this tab to a phone, so each line of text is a test of legibility and bandwidth.</p>`,
).join("");

const page = (
  body,
  script,
  extraStyle = "",
) => `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;background:#fff;color:#111;font:15px/1.45 -apple-system,Helvetica,Arial,sans-serif}
main{padding:48px 32px 32px}
h1{font-size:26px;margin:0 0 12px}
.boxes{display:flex;gap:12px;margin:16px 0}
.boxes div{width:120px;height:80px;border-radius:10px}
${extraStyle}
</style></head><body>${body}<script>${markerScript}${script}</script></body></html>`;

const header = (title) =>
  `<h1>${title}</h1><div class="boxes"><div style="background:#e63946"></div><div style="background:#f1c40f"></div><div style="background:#2a9d8f"></div><div style="background:#264653"></div></div>`;

/** @type {Record<string, () => string>} */
export const SCENES = {
  // Nothing moves at all: the bandwidth floor.
  idle: () => page(`<main>${header("Idle page")}${article}</main>`, ""),
  // Static page; only the marker changes. Change-to-visible on a quiet page.
  ticks: () => page(`<main>${header("Ticks")}${article}</main>`, "window.__startTicks();"),
  // A focused field with a blinking caret, plus marker ticks.
  caret: () =>
    page(
      `<main>${header("Caret")}<textarea id="field" rows="3" cols="60">Focused field</textarea>${article}</main>`,
      `const field = document.getElementById("field"); field.focus(); field.setSelectionRange(5, 5); window.__startTicks();`,
    ),
  // A small CSS spinner turning forever, plus marker ticks.
  spinner: () =>
    page(
      `<main>${header("Spinner")}<div class="spinner"></div>${article}</main>`,
      "window.__startTicks();",
      `.spinner{width:28px;height:28px;border:4px solid #ddd;border-top-color:#2a9d8f;border-radius:50%;animation:spin 0.8s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}`,
    ),
  // One character every 120 ms into a field; every character is a marker tick.
  typing: () =>
    page(
      `<main>${header("Typing")}<textarea id="field" rows="6" cols="70"></textarea>${article}</main>`,
      `const field = document.getElementById("field");
       const text = "The quick brown fox jumps over the lazy dog. ";
       let index = 0;
       setInterval(() => {
         if (field.value.length > 380) field.value = "";
         field.value += text[index++ % text.length];
         window.__tickMarker();
       }, 120);`,
    ),
  // The page scrolls continuously (240 px/s); the marker stays pinned.
  scroll: () =>
    page(
      `<main>${header("Scrolling")}${article}${article}${article}${article}</main>`,
      `let last = performance.now();
       const max = () => document.documentElement.scrollHeight - innerHeight;
       const frame = (now) => {
         const delta = (now - last) * 0.24; last = now;
         let next = scrollY + delta; if (next >= max()) next = 0;
         scrollTo(0, next);
         requestAnimationFrame(frame);
       };
       requestAnimationFrame(frame);
       window.__startTicks();`,
    ),
  // A 640x360 region repainted at 30 fps, standing in for a playing video.
  video: () =>
    page(
      `<main>${header("Video")}<canvas id="video" width="640" height="360" style="width:640px;height:360px;display:block"></canvas>${article}</main>`,
      `const canvas = document.getElementById("video");
       const ctx = canvas.getContext("2d");
       let frame = 0;
       setInterval(() => {
         frame++;
         const t = frame / 30;
         const gradient = ctx.createLinearGradient(0, 0, 640, 360);
         gradient.addColorStop(0, "hsl(" + ((t * 40) % 360) + ",70%,45%)");
         gradient.addColorStop(1, "hsl(" + ((t * 40 + 120) % 360) + ",70%,35%)");
         ctx.fillStyle = gradient; ctx.fillRect(0, 0, 640, 360);
         for (let i = 0; i < 12; i++) {
           ctx.fillStyle = "hsla(" + (i * 30) + ",80%,70%,0.8)";
           const x = 320 + Math.cos(t * (1 + i * 0.1) + i) * (80 + i * 18);
           const y = 180 + Math.sin(t * (1.3 + i * 0.07) + i) * (50 + i * 9);
           ctx.beginPath(); ctx.arc(x, y, 18 + (i % 4) * 6, 0, Math.PI * 2); ctx.fill();
         }
         ctx.fillStyle = "#fff"; ctx.font = "bold 28px sans-serif"; ctx.fillText("frame " + frame, 24, 44);
       }, 1000 / 30);
       window.__startTicks();`,
    ),
  // A full-page button: every mousedown is a marker tick (input-to-visible).
  input: () =>
    page(
      `<button id="target" style="position:fixed;inset:0;width:100%;height:100%;border:0;background:#f7f7f7;font-size:22px">Press anywhere</button>`,
      `document.getElementById("target").addEventListener("mousedown", () => window.__tickMarker());`,
    ),
};

/**
 * Reads the marker out of a decoded frame.
 * @param {(x: number, y: number) => number} luminanceAt frame-pixel luminance 0..255
 * @param {{ width: number, height: number }} frame frame size in pixels
 * @returns {number | null} the counter, or null when the cells do not decode (parity)
 */
export function readMarker(luminanceAt, frame) {
  if (!(frame.width > 0 && frame.height > 0)) return null;
  const scaleX = frame.width / SCENE_VIEWPORT.width;
  const scaleY = frame.height / SCENE_VIEWPORT.height;
  let value = 0;
  let parity = 0;
  for (let i = 0; i < MARKER.bits; i++) {
    const cx = (MARKER.left + i * MARKER.cell + MARKER.cell / 2) * scaleX;
    const cy = (MARKER.top + MARKER.cell / 2) * scaleY;
    let sum = 0;
    let count = 0;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const x = Math.round(cx + dx);
        const y = Math.round(cy + dy);
        if (x < 0 || y < 0 || x >= frame.width || y >= frame.height) return null;
        const luma = luminanceAt(x, y);
        if (!Number.isFinite(luma)) return null;
        sum += luma;
        count++;
      }
    }
    const bit = sum / count < 128 ? 1 : 0;
    if (i < MARKER.bits - 1) {
      value |= bit << i;
      parity ^= bit;
    } else if (bit !== parity) {
      return null;
    }
  }
  // Scenes start at one. A blank white capture decodes as zero with valid parity.
  return value === 0 ? null : value;
}
