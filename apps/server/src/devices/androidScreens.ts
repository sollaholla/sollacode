// @effect-diagnostics globalTimers:off - Paces a synthetic swipe on a plain HTTP request.
// @effect-diagnostics globalDate:off - Measures how long a finger was held.
import {
  physicalPoint,
  type EmulatorControl,
  type EmulatorRotation,
} from "./androidEmulatorControl.ts";
import {
  ANDROID_KEYS,
  pngSize,
  quoteAndroidInputText,
  type AndroidScreen,
  type AndroidViewerInput,
} from "./androidViewer.ts";

interface PanelSize {
  readonly width: number;
  readonly height: number;
}

const SWIPE_STEPS = 8;
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** `adb -s <serial> ...` arguments for a key or button. */
export function adbKeyArgs(key: AndroidViewerKeyName): string[] {
  return key === "rotate"
    ? ["emu", "rotate"]
    : ["shell", "input", "keyevent", String(ANDROID_KEYS[key].keyCode)];
}

export function adbTextArgs(text: string): string[] {
  return ["shell", "input", "text", quoteAndroidInputText(text)];
}

type AndroidViewerKeyName = Extract<AndroidViewerInput, { kind: "key" }>["key"];

/**
 * The emulator's own control port: scaled screenshots in tens of
 * milliseconds and touches that follow the finger as it moves. Keys and
 * typing go through adb, because the control port drops hardware keys on
 * windowless emulators.
 */
export function grpcAndroidScreen(input: {
  readonly control: EmulatorControl;
  /** The panel in its natural portrait orientation, from the AVD's config, when known. */
  readonly panel: PanelSize | null;
  readonly adb: (args: ReadonlyArray<string>) => Promise<void>;
}): AndroidScreen {
  let panel = input.panel;
  let rotation: EmulatorRotation = 0;

  const learnPanel = async (): Promise<PanelSize> => {
    const full = await input.control.screenshot(0, 0);
    rotation = full.rotation;
    panel =
      rotation % 2 === 1
        ? { width: full.height, height: full.width }
        : { width: full.width, height: full.height };
    return panel;
  };

  const point = async (fx: number, fy: number) => {
    const size = panel ?? (await learnPanel());
    return physicalPoint({
      fx,
      fy,
      panelWidth: size.width,
      panelHeight: size.height,
      rotation,
    });
  };

  const touch = async (fx: number, fy: number, down: boolean) => {
    const { x, y } = await point(fx, fy);
    await input.control.touch(x, y, down);
  };

  return {
    capture: async (maxWidth) => {
      const size = panel ?? (await learnPanel());
      // A rotation since the last frame shows up in the reply; ask again at the new shape.
      for (let attempt = 0; ; attempt += 1) {
        const turned = rotation % 2 === 1;
        const displayWidth = turned ? size.height : size.width;
        const displayHeight = turned ? size.width : size.height;
        const width = Math.min(displayWidth, Math.max(160, Math.round(maxWidth)));
        const height = Math.round((width * displayHeight) / displayWidth);
        const shot = await input.control.screenshot(width, height);
        const changed = shot.rotation !== rotation;
        rotation = shot.rotation;
        if (!changed || attempt > 0) return shot.png;
      }
    },
    input: async (event: AndroidViewerInput) => {
      switch (event.kind) {
        case "touch":
          await touch(event.x, event.y, event.phase !== "up");
          return;
        case "swipe": {
          await touch(event.x1, event.y1, true);
          for (let step = 1; step <= SWIPE_STEPS; step += 1) {
            await delay(event.durationMs / SWIPE_STEPS);
            const t = step / SWIPE_STEPS;
            await touch(
              event.x1 + (event.x2 - event.x1) * t,
              event.y1 + (event.y2 - event.y1) * t,
              true,
            );
          }
          await touch(event.x2, event.y2, false);
          return;
        }
        case "text":
          await input.adb(adbTextArgs(event.text));
          return;
        case "key":
          await input.adb(adbKeyArgs(event.key));
          return;
      }
    },
  };
}

/**
 * The fallback for emulators without a control port: `adb screencap` and
 * `adb shell input`, which take about half a second each. A drag is sent as
 * one swipe when the finger lifts.
 */
export function adbAndroidScreen(input: {
  readonly capture: () => Promise<Buffer>;
  readonly adb: (args: ReadonlyArray<string>) => Promise<void>;
}): AndroidScreen {
  let size: { width: number; height: number } | null = null;
  let pressed: { x: number; y: number; at: number } | null = null;

  const pixels = (fx: number, fy: number) => ({
    x: Math.round(fx * ((size?.width ?? 1) - 1)),
    y: Math.round(fy * ((size?.height ?? 1) - 1)),
  });
  const swipe = (
    from: { x: number; y: number },
    to: { x: number; y: number },
    durationMs: number,
  ) =>
    input.adb([
      "shell",
      "input",
      "swipe",
      String(from.x),
      String(from.y),
      String(to.x),
      String(to.y),
      String(Math.round(durationMs)),
    ]);

  return {
    capture: async () => {
      const png = await input.capture();
      size = pngSize(png) ?? size;
      return png;
    },
    input: async (event) => {
      switch (event.kind) {
        case "touch": {
          if (event.phase === "down") {
            pressed = { x: event.x, y: event.y, at: Date.now() };
            return;
          }
          if (event.phase === "move" || pressed === null || size === null) return;
          const start = pixels(pressed.x, pressed.y);
          const end = pixels(event.x, event.y);
          const heldMs = Date.now() - pressed.at;
          pressed = null;
          if (Math.hypot(end.x - start.x, end.y - start.y) > 12) {
            await swipe(start, end, Math.max(120, heldMs));
          } else if (heldMs >= 500) {
            await swipe(start, start, heldMs);
          } else {
            await input.adb(["shell", "input", "tap", String(start.x), String(start.y)]);
          }
          return;
        }
        case "swipe":
          if (size === null) return;
          await swipe(pixels(event.x1, event.y1), pixels(event.x2, event.y2), event.durationMs);
          return;
        case "text":
          await input.adb(adbTextArgs(event.text));
          return;
        case "key":
          await input.adb(adbKeyArgs(event.key));
          return;
      }
    },
  };
}
