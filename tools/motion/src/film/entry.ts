import { createBoltRenderer, type BoltMesh } from "../../../../apps/marketing/src/lib/boltRenderer";
import { FPS, SCENE_SECONDS, SCENES } from "./scenes";

declare global {
  interface Window {
    filmAssets: { mesh: BoltMesh; sources: Record<string, string>; font: string; logo: string };
    film: { ready: () => Promise<void>; frame: (scene: number, frame: number) => Promise<void> };
  }
}

const style = document.createElement("style");
style.textContent = `
@font-face{font-family:DM;src:url('${window.filmAssets.font}') format('woff2');font-weight:100 1000;font-display:block}
*{box-sizing:border-box}html,body{margin:0;width:1920px;height:1080px;overflow:hidden;background:#080808;color:#f4f2eb;font-family:DM,sans-serif}
.light{position:absolute;inset:0;background:radial-gradient(ellipse at 78% 54%,#60451922,transparent 52%);pointer-events:none}
.top{position:absolute;top:64px;left:84px;right:84px;display:flex;align-items:center;justify-content:space-between;font-size:18px;letter-spacing:-.3px;color:#c7c3ba}
.wordmark{display:flex;align-items:center;gap:12px;font-weight:550;color:#f4f2eb}.wordmark img{width:25px;height:31px;object-fit:contain}.top small{color:#777670;font-size:13px;letter-spacing:1.6px}
.copy{position:absolute;left:84px;top:302px;width:480px}.eyebrow{font-size:13px;font-weight:550;letter-spacing:2px;color:#d6ae65;margin-bottom:35px}
h1{font-size:64px;font-weight:550;letter-spacing:-3px;line-height:1.06;margin:0}h1 span{display:block}h1 span:last-child{color:#e6b765}
.description{font-size:21px;line-height:1.55;color:#959590;max-width:365px;margin-top:30px;font-weight:400}
.screen{position:absolute;left:618px;top:142px;width:1200px;height:832px;border:1px solid #39372f;border-radius:17px;overflow:hidden;background:#090909;box-shadow:0 30px 85px #000b;transform-origin:55% 50%}
video{position:absolute;inset:0;width:100%;height:100%;object-fit:contain;display:none}
.cursor{position:absolute;left:0;top:0;width:23px;height:31px;filter:drop-shadow(0 2px 3px #0009);z-index:2;pointer-events:none;display:none}.ring{position:absolute;width:48px;height:48px;border:2px solid #f6ce83;border-radius:50%;z-index:1;pointer-events:none;display:none}
.bolt{position:absolute;left:982px;top:156px;width:810px;height:810px}.brand .copy{top:312px;width:880px}.brand h1{font-size:108px;letter-spacing:-5.6px;line-height:1.01}.brand .description{max-width:760px;font-size:25px;margin-top:35px}
.foot{position:absolute;left:84px;right:84px;bottom:48px;display:flex;justify-content:space-between;font-size:13px;color:#77766f;letter-spacing:.2px}.progress{position:absolute;left:84px;bottom:26px;height:1px;width:1752px;background:#24221e}.progress i{display:block;height:1px;background:#be9652;transform-origin:left}
`;
document.head.append(style);
document.body.innerHTML = `<div class="light"></div><header class="top"><div class="wordmark"><img src="${window.filmAssets.logo}" alt="" />Solla Code</div><small>THE WORKSPACE, IN MOTION</small></header><main><div class="copy"><div class="eyebrow"></div><h1></h1><p class="description"></p></div><div class="screen"><svg class="cursor" viewBox="0 0 23 31"><path d="M2 1.5 20.4 17l-8.5 1.2 5.1 9.3-4.1 2.2-5-9.4L2 26Z" fill="#fff8e9" stroke="#17140e" stroke-width="1.5" stroke-linejoin="round"/></svg><div class="ring"></div></div><canvas class="bolt"></canvas></main><footer class="foot"><span class="note"></span><span class="counter"></span></footer><div class="progress"><i></i></div>`;

function element<T extends Element>(selector: string) {
  const found = document.querySelector<T>(selector);
  if (!found) throw new Error(`Missing film element: ${selector}`);
  return found;
}
const canvas = element<HTMLCanvasElement>(".bolt");
const bolt = createBoltRenderer(canvas, window.filmAssets.mesh);
const screen = element<HTMLDivElement>(".screen");
const copy = element<HTMLDivElement>(".copy");
const cursor = element<SVGElement>(".cursor");
const ring = element<HTMLDivElement>(".ring");
const videos = new Map<string, HTMLVideoElement>();
for (const [name, source] of Object.entries(window.filmAssets.sources)) {
  const video = document.createElement("video");
  video.muted = true;
  video.preload = "auto";
  video.src = source;
  screen.prepend(video);
  videos.set(name, video);
}
const clamp = (x: number) => Math.max(0, Math.min(1, x));
const ease = (x: number) => 1 - (1 - clamp(x)) ** 3;
let previousScene = -1;

async function seek(video: HTMLVideoElement, time: number) {
  const target = Math.min(time, Math.max(0, video.duration - 0.12));
  if (Math.abs(video.currentTime - target) < 0.001 && video.readyState >= 2) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Video seek stalled: ${video.src}`)), 5000);
    video.addEventListener(
      "seeked",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
    video.currentTime = target;
  });
}

window.film = {
  async ready() {
    await document.fonts.ready;
    await Promise.all(
      [...videos.values()].map((video) =>
        video.readyState >= 2
          ? Promise.resolve()
          : new Promise<void>((resolve, reject) => {
              video.addEventListener("loadeddata", () => resolve(), { once: true });
              video.addEventListener("error", () => reject(new Error(`Cannot load ${video.src}`)), {
                once: true,
              });
            }),
      ),
    );
  },
  async frame(sceneIndex, frame) {
    const scene = SCENES[sceneIndex];
    if (!scene) throw new Error("Unknown film scene");
    const time = frame / FPS;
    const brand = !scene.source;
    if (previousScene !== sceneIndex) {
      previousScene = sceneIndex;
      document.body.classList.toggle("brand", brand);
      element(".eyebrow").textContent = scene.eyebrow;
      const title = element("h1");
      title.replaceChildren(
        ...scene.title.map((line) => {
          const span = document.createElement("span");
          span.textContent = line;
          return span;
        }),
      );
      element(".description").textContent = scene.description;
      element(".note").textContent =
        scene.id === "closing"
          ? "Subscriptions preparing for launch. Provider usage is separate."
          : scene.id === "opening"
            ? "Original design and soundtrack."
            : "Actual Solla Code client. Illustrative project content.";
      element(".counter").textContent =
        `${String(sceneIndex + 1).padStart(2, "0")} / ${String(SCENES.length).padStart(2, "0")}`;
      for (const [name, video] of videos)
        video.style.display = name === scene.source ? "block" : "none";
    }
    const entrance = ease(time / 0.8);
    const exit = clamp((SCENE_SECONDS - time) / 0.35);
    copy.style.opacity = String(entrance * exit);
    copy.style.transform = `translateY(${(1 - entrance) * 18}px)`;
    screen.style.display = brand ? "none" : "block";
    screen.style.width = scene.id === "voice" ? "880px" : "1200px";
    screen.style.left = scene.id === "voice" ? "778px" : "618px";
    canvas.style.display = brand ? "block" : "none";
    if (brand) {
      const phase = scene.id === "closing" ? 0.25 : -0.32;
      bolt.draw(
        -0.08 + Math.sin(time * 0.65) * 0.055,
        phase + Math.PI * 2 * ease(time / 7.6),
        810,
        810,
        1.6,
      );
      canvas.style.opacity = String(Math.min(1, time / 0.55) * exit);
    } else {
      const video = videos.get(scene.source!);
      if (!video) throw new Error(`Missing source recording: ${scene.source}`);
      await seek(video, (scene.sourceStart ?? 0) + time);
      screen.style.opacity = String(clamp(time / 0.25) * exit);
      screen.style.transform = `translateY(${(1 - entrance) * 12}px)`;
      const actions = scene.actions ?? [];
      const sourceTime = (scene.sourceStart ?? 0) + time;
      const next = actions.find((action) => action.at >= sourceTime - 0.9);
      cursor.style.display = next ? "block" : "none";
      ring.style.display = "none";
      if (next) {
        const index = actions.indexOf(next);
        const previous = actions[index - 1] ?? { x: 940, y: 780 };
        const motion = ease((sourceTime - (next.at - 0.85)) / 0.85);
        const x = ((previous.x + (next.x - previous.x) * motion) * 1200) / 1314;
        const y = ((previous.y + (next.y - previous.y) * motion) * 832) / 912;
        cursor.style.transform = `translate(${x}px,${y}px)`;
        const sinceClick = sourceTime - next.at;
        if (next.kind !== "type" && sinceClick >= 0 && sinceClick <= 0.65) {
          ring.style.display = "block";
          ring.style.opacity = String(1 - sinceClick / 0.65);
          ring.style.transform = `translate(${x - 24}px,${y - 24}px) scale(${0.25 + sinceClick * 1.7})`;
        }
      }
    }
    element<HTMLElement>(".progress i").style.transform =
      `scaleX(${(sceneIndex * SCENE_SECONDS + time) / (SCENES.length * SCENE_SECONDS)})`;
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  },
};
