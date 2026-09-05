/** Frame-controlled presentation of unmodified client recordings. */
export interface ClipAssets {
  source: string;
  width: number;
  height: number;
  title: string;
  note: string;
  actions: { at: number; x: number; y: number }[];
}

declare global {
  interface Window {
    clipAssets: ClipAssets;
    clip: { ready: () => Promise<void>; frame: (time: number) => Promise<void> };
  }
}

const assets = window.clipAssets;
const style = document.createElement("style");
style.textContent = `
*{box-sizing:border-box}html,body{margin:0;background:#080808;color:#eeeae1;font-family:Arial,sans-serif}
header{height:58px;padding:0 24px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid #353025}
strong{font-size:17px;letter-spacing:-.3px}small{font-size:12px;color:#aaa69d}
.screen{position:relative;overflow:hidden}video{display:block;width:100%;height:100%}
.cursor{position:absolute;top:0;left:0;width:21px;height:29px;filter:drop-shadow(0 2px 3px #0009);pointer-events:none;display:none}
.ring{position:absolute;top:0;left:0;width:42px;height:42px;border:2px solid #e7bd70;border-radius:50%;display:none}
`;
document.head.append(style);
document.body.innerHTML = `<header><strong></strong><small></small></header><div class="screen"><video muted></video><div class="ring"></div><svg class="cursor" viewBox="0 0 23 31"><path d="M2 1.5 20.4 17l-8.5 1.2 5.1 9.3-4.1 2.2-5-9.4L2 26Z" fill="#fff8e9" stroke="#17140e" stroke-width="1.5" stroke-linejoin="round"/></svg></div>`;
document.querySelector("strong")!.textContent = assets.title;
document.querySelector("small")!.textContent = assets.note;
const screen = document.querySelector<HTMLDivElement>(".screen")!;
const video = document.querySelector<HTMLVideoElement>("video")!;
const cursor = document.querySelector<SVGElement>(".cursor")!;
const ring = document.querySelector<HTMLDivElement>(".ring")!;
screen.style.width = `${assets.width}px`;
screen.style.height = `${assets.height}px`;
video.src = assets.source;
const ease = (value: number) => 1 - (1 - Math.max(0, Math.min(1, value))) ** 3;
window.clip = {
  ready: () =>
    video.readyState >= 2
      ? Promise.resolve()
      : new Promise((resolve, reject) => {
          video.addEventListener("loadeddata", () => resolve(), { once: true });
          video.addEventListener("error", () => reject(new Error("Cannot load client recording")), {
            once: true,
          });
        }),
  async frame(time) {
    const target = Math.min(time, video.duration - 0.1);
    if (Math.abs(video.currentTime - target) > 0.001) {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error("Client recording seek timed out")),
          5000,
        );
        video.addEventListener(
          "seeked",
          () => {
            clearTimeout(timeout);
            resolve();
          },
          { once: true },
        );
        video.currentTime = target;
      });
    }
    const action = assets.actions.find((entry) => entry.at >= time - 0.7);
    cursor.style.display = action ? "block" : "none";
    ring.style.display = "none";
    if (action) {
      const previous = assets.actions[assets.actions.indexOf(action) - 1] ?? {
        x: assets.width * 0.7,
        y: assets.height * 0.8,
      };
      const progress = ease((time - action.at + 0.75) / 0.75);
      const x = previous.x + (action.x - previous.x) * progress;
      const y = previous.y + (action.y - previous.y) * progress;
      cursor.style.transform = `translate(${x}px,${y}px)`;
      const elapsed = time - action.at;
      if (elapsed >= 0 && elapsed < 0.6) {
        ring.style.display = "block";
        ring.style.opacity = String(1 - elapsed / 0.6);
        ring.style.transform = `translate(${x - 21}px,${y - 21}px) scale(${0.3 + elapsed * 1.7})`;
      }
    }
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  },
};
