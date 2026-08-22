/**
 * MockVmProvider - an in-memory {@link VmProvider} for development and tests.
 *
 * It fakes VM lifecycle (create/start/stop/delete always succeed) and renders a
 * synthetic, animated desktop for each "VM": a hue-cycling background with a
 * sweeping vertical bar and the agent's name band. This proves the whole
 * create → live-screen → delete pipeline without any hypervisor installed.
 */
import { VmId, VmProviderError } from "@t3tools/contracts";
import * as NodeZlib from "node:zlib";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { VmProvider, type VmCapturedFrame, type VmProviderShape } from "./VmProvider.ts";

const WIDTH = 320;
const HEIGHT = 200;

// ── Minimal PNG (RGB, 8-bit) encoder ────────────────────────────────

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c;
  }
  return table;
})();

const crc32 = (buf: Buffer): number => {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
};

const chunk = (type: string, data: Buffer): Buffer => {
  const typeBuf = Buffer.from(type, "ascii");
  const lengthBuf = Buffer.alloc(4);
  lengthBuf.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([lengthBuf, typeBuf, data, crcBuf]);
};

const encodePng = (width: number, height: number, rgb: Buffer): Buffer => {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.writeUInt8(8, 8); // bit depth
  ihdr.writeUInt8(2, 9); // color type: truecolor RGB
  ihdr.writeUInt8(0, 10); // compression
  ihdr.writeUInt8(0, 11); // filter
  ihdr.writeUInt8(0, 12); // interlace

  // Prepend a zero filter byte to each scanline.
  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgb.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const idat = NodeZlib.deflateSync(raw);

  return Buffer.concat([
    signature,
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0)),
  ]);
};

// ── Frame rendering ─────────────────────────────────────────────────

const hsvToRgb = (h: number, s: number, v: number): [number, number, number] => {
  const i = Math.floor(h * 6);
  const f = h * 6 - i;
  const p = v * (1 - s);
  const q = v * (1 - f * s);
  const t = v * (1 - (1 - f) * s);
  let r = v;
  let g = t;
  let b = p;
  switch (i % 6) {
    case 1:
      r = q;
      g = v;
      b = p;
      break;
    case 2:
      r = p;
      g = v;
      b = t;
      break;
    case 3:
      r = p;
      g = q;
      b = v;
      break;
    case 4:
      r = t;
      g = p;
      b = v;
      break;
    case 5:
      r = v;
      g = p;
      b = q;
      break;
  }
  return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
};

/** The agent's synthetic pointer traces a slow Lissajous path across the frame. */
const cursorPosition = (frame: number): { x: number; y: number } => ({
  x: Math.round((WIDTH / 2) * (1 + 0.8 * Math.sin(frame * 0.05))),
  y: Math.round((HEIGHT / 2) * (1 + 0.8 * Math.sin(frame * 0.037 + 1))),
});

// How long (in frames) the user's activity keeps painting into the mock desktop
// after their last input, at ~7fps. Long enough that the picture reacts to
// takeover, short enough that it settles back to the agent's animation.
const USER_ACTIVE_FRAMES = 28;
const CLICK_RIPPLE_FRAMES = 10;
const KEY_FLASH_FRAMES = 8;

const putPixel = (rgb: Buffer, x: number, y: number, r: number, g: number, b: number) => {
  if (x < 0 || x >= WIDTH || y < 0 || y >= HEIGHT) return;
  const i = (Math.round(y) * WIDTH + Math.round(x)) * 3;
  rgb[i] = r;
  rgb[i + 1] = g;
  rgb[i + 2] = b;
};

const fillDisc = (
  rgb: Buffer,
  cx: number,
  cy: number,
  radius: number,
  [r, g, b]: [number, number, number],
) => {
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      if (dx * dx + dy * dy <= radius * radius) putPixel(rgb, cx + dx, cy + dy, r, g, b);
    }
  }
};

const strokeRing = (
  rgb: Buffer,
  cx: number,
  cy: number,
  radius: number,
  [r, g, b]: [number, number, number],
) => {
  for (let a = 0; a < 360; a += 6) {
    const rad = (a * Math.PI) / 180;
    putPixel(rgb, cx + Math.cos(rad) * radius, cy + Math.sin(rad) * radius, r, g, b);
  }
};

interface UserActivity {
  x: number;
  y: number;
  lastFrame: number;
  clickFrame: number;
  keyFrame: number;
}

const renderFrame = (frame: number, user: UserActivity | null): Buffer => {
  const rgb = Buffer.alloc(WIDTH * HEIGHT * 3);
  const hue = (frame % 120) / 120;
  const [br, bg, bb] = hsvToRgb(hue, 0.35, 0.5);
  const barX = frame % WIDTH;
  const bandTop = HEIGHT / 2 - 16;
  const bandBottom = HEIGHT / 2 + 16;
  for (let y = 0; y < HEIGHT; y++) {
    const inBand = y >= bandTop && y < bandBottom;
    for (let x = 0; x < WIDTH; x++) {
      const i = (y * WIDTH + x) * 3;
      const onBar = Math.abs(x - barX) < 6;
      if (onBar) {
        rgb[i] = 250;
        rgb[i + 1] = 250;
        rgb[i + 2] = 250;
      } else if (inBand) {
        rgb[i] = 20;
        rgb[i + 1] = 22;
        rgb[i + 2] = 28;
      } else {
        rgb[i] = br;
        rgb[i + 1] = bg;
        rgb[i + 2] = bb;
      }
    }
  }
  // When the user is driving (takeover), paint their pointer, click ripples, and
  // a key-activity flash directly into the desktop — visible proof that input
  // reached the guest. The agent's own cursor is drawn by the viewer overlay,
  // not here, so the two never fight.
  if (user && frame - user.lastFrame < USER_ACTIVE_FRAMES) {
    const cyan: [number, number, number] = [64, 224, 208];
    if (frame - user.clickFrame < CLICK_RIPPLE_FRAMES) {
      strokeRing(rgb, user.x, user.y, 4 + (frame - user.clickFrame) * 2, [255, 255, 255]);
    }
    if (frame - user.keyFrame < KEY_FLASH_FRAMES) {
      fillDisc(rgb, user.x + 10, user.y - 10, 3, [255, 214, 10]);
    }
    fillDisc(rgb, user.x, user.y, 4, cyan);
    strokeRing(rgb, user.x, user.y, 5, [0, 0, 0]);
  }
  return rgb;
};

interface MockVm {
  frame: number;
  running: boolean;
  user: UserActivity | null;
}

const makeMockVmProvider = Effect.sync(() => {
  const vms = new Map<string, MockVm>();

  const ensure = (vmId: VmId): MockVm => {
    let vm = vms.get(vmId);
    if (!vm) {
      vm = { frame: 0, running: false, user: null };
      vms.set(vmId, vm);
    }
    return vm;
  };

  const provider: VmProviderShape = {
    name: "mock",
    isAvailable: () => Effect.succeed(true),
    create: ({ vmId }) =>
      Effect.sync(() => {
        ensure(vmId);
      }),
    start: (vmId) =>
      Effect.sync(() => {
        const vm = ensure(vmId);
        vm.running = true;
        // A stable synthetic loopback IP so downstream code has something real.
        return { guestIp: "127.0.0.1" };
      }),
    stop: (vmId) =>
      Effect.sync(() => {
        const vm = ensure(vmId);
        vm.running = false;
      }),
    delete: (vmId) =>
      Effect.sync(() => {
        vms.delete(vmId);
      }),
    capture: (vmId) =>
      Effect.suspend(() => {
        const vm = vms.get(vmId);
        if (!vm || !vm.running) {
          return Effect.fail(
            new VmProviderError({
              operation: "capture",
              vmId,
              detail: "VM is not running",
            }),
          );
        }
        vm.frame += 1;
        // While the user is actively driving, report their pointer as the live
        // cursor; otherwise report the agent's synthetic pointer.
        const userActive = vm.user !== null && vm.frame - vm.user.lastFrame < USER_ACTIVE_FRAMES;
        const cursor =
          userActive && vm.user ? { x: vm.user.x, y: vm.user.y } : cursorPosition(vm.frame);
        const png = encodePng(WIDTH, HEIGHT, renderFrame(vm.frame, vm.user));
        return Effect.succeed<VmCapturedFrame>({
          width: WIDTH,
          height: HEIGHT,
          format: "png",
          data: png.toString("base64"),
          cursor,
        });
      }),
    input: (vmId, event) =>
      Effect.suspend(() => {
        const vm = vms.get(vmId);
        if (!vm || !vm.running) {
          return Effect.fail(
            new VmProviderError({ operation: "input", vmId, detail: "VM is not running" }),
          );
        }
        // Denormalize pointer/scroll coordinates onto the mock's resolution and
        // record the activity so the next captured frame reflects it.
        const prior = vm.user;
        if (event.type === "pointer" || event.type === "scroll") {
          const x = Math.round(Math.min(1, Math.max(0, event.x)) * (WIDTH - 1));
          const y = Math.round(Math.min(1, Math.max(0, event.y)) * (HEIGHT - 1));
          vm.user = {
            x,
            y,
            lastFrame: vm.frame,
            clickFrame:
              event.type === "pointer" && event.action === "down"
                ? vm.frame
                : (prior?.clickFrame ?? -100),
            keyFrame: prior?.keyFrame ?? -100,
          };
        } else {
          // Keyboard (key/text/press): keep the last pointer position, flash the
          // key indicator on a down edge (text/press always register).
          const keyDownEdge = event.type === "key" ? event.action === "down" : true;
          vm.user = {
            x: prior?.x ?? Math.round(WIDTH / 2),
            y: prior?.y ?? Math.round(HEIGHT / 2),
            lastFrame: vm.frame,
            clickFrame: prior?.clickFrame ?? -100,
            keyFrame: keyDownEdge ? vm.frame : (prior?.keyFrame ?? -100),
          };
        }
        return Effect.void;
      }),
  };

  return provider;
});

export const VmProviderMockLive = Layer.effect(VmProvider, makeMockVmProvider);
