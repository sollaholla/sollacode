// @vitest-environment happy-dom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import { useAgentHeaderFold } from "./useAgentHeaderFold";

interface FakeAnimation {
  readonly keyframes: ReadonlyArray<{ transform: string }>;
  onfinish: (() => void) | null;
  cancel: () => void;
}

const animations: FakeAnimation[] = [];
const collapsedCalls: boolean[] = [];
let root: Root;
let container: HTMLDivElement;
let slot: HTMLDivElement;

function placeAt(element: Element, rect: { left: number; top: number; size: number }) {
  Object.defineProperty(element, "getBoundingClientRect", {
    configurable: true,
    value: () => ({
      left: rect.left,
      top: rect.top,
      width: rect.size,
      height: rect.size,
      right: rect.left + rect.size,
      bottom: rect.top + rect.size,
    }),
  });
}

function Harness() {
  const [collapsed, setCollapsed] = useState(false);
  const fold = useAgentHeaderFold({
    enabled: true,
    slot,
    setCollapsed: (next) => {
      collapsedCalls.push(next);
      setCollapsed(next);
    },
  });
  return (
    <>
      <div
        {...fold.cardAvatarProps}
        data-card-avatar=""
        className={fold.flying ? "invisible" : undefined}
      />
      {collapsed ? (
        <button type="button" data-bar-avatar="" onClick={fold.unfold}>
          <span
            ref={(element) => {
              fold.barAvatarRef.current = element;
              if (element) placeAt(element, { left: 272, top: 8, size: 32 });
            }}
          />
        </button>
      ) : null}
      {fold.standIn(<span>avatar</span>)}
    </>
  );
}

const card = () => container.querySelector<HTMLElement>("[data-card-avatar]")!;
const standIn = () => document.querySelector<HTMLElement>("[data-agent-avatar-stand-in]");

function pointer(type: string, x: number, y: number) {
  card().dispatchEvent(
    new PointerEvent(type, {
      bubbles: true,
      clientX: x,
      clientY: y,
      pointerId: 7,
      pointerType: "touch",
    }),
  );
}

async function drag(path: ReadonlyArray<readonly [number, number]>) {
  await act(async () => {
    const [first, ...rest] = path;
    pointer("pointerdown", first![0], first![1]);
    for (const [x, y] of rest) pointer("pointermove", x, y);
    const last = path.at(-1)!;
    pointer("pointerup", last[0], last[1]);
  });
}

async function finishFlight() {
  await act(async () => {
    animations.at(-1)!.onfinish?.();
  });
}

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(window, "matchMedia").mockReturnValue({ matches: false } as MediaQueryList);
  Object.defineProperty(HTMLElement.prototype, "animate", {
    configurable: true,
    value(keyframes: ReadonlyArray<{ transform: string }>) {
      const animation: FakeAnimation = { keyframes, onfinish: null, cancel: () => undefined };
      animations.push(animation);
      return animation;
    },
  });
  animations.length = 0;
  collapsedCalls.length = 0;
  slot = document.createElement("div");
  placeAt(slot, { left: 340, top: 24, size: 0 });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root.render(<Harness />);
  });
  placeAt(card(), { left: 28, top: 80, size: 40 });
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("folds when the avatar is dragged up and to the right, landing on the top bar", async () => {
  await drag([
    [48, 100],
    [60, 96],
    [180, 60],
  ]);

  expect(collapsedCalls).toEqual([true]);
  expect(card().className).toBe("invisible");
  const flight = animations.at(-1)!;
  // From wherever the finger let go, to the folded avatar's place.
  expect(flight.keyframes[0]!.transform).toMatch(/^translate\(132px, -40px\) scale\(0\.89/);
  expect(flight.keyframes[1]!.transform).toBe("translate(244px, -72px) scale(0.8)");

  await finishFlight();
  expect(standIn()).toBeNull();
});

it("sends a short nudge back to the card", async () => {
  await drag([
    [48, 100],
    [60, 100],
    [70, 104],
  ]);

  expect(collapsedCalls).toEqual([]);
  expect(animations.at(-1)!.keyframes[1]!.transform).toBe("translate(0px, 0px) scale(1)");
  await finishFlight();
  expect(standIn()).toBeNull();
  expect(card().className).toBe("");
});

it("ignores a plain tap on the avatar", async () => {
  await drag([
    [48, 100],
    [50, 101],
  ]);

  expect(collapsedCalls).toEqual([]);
  expect(standIn()).toBeNull();
  expect(animations).toHaveLength(0);
});

it("flies back to the card when the folded avatar is tapped", async () => {
  await drag([
    [48, 100],
    [60, 96],
    [260, 30],
  ]);
  await finishFlight();

  await act(async () => {
    container.querySelector<HTMLElement>("[data-bar-avatar]")!.click();
  });

  expect(collapsedCalls).toEqual([true, false]);
  const flight = animations.at(-1)!;
  expect(flight.keyframes[0]!.transform).toBe("translate(244px, -72px) scale(0.8)");
  expect(flight.keyframes[1]!.transform).toBe("translate(0px, 0px) scale(1)");
  await finishFlight();
  expect(standIn()).toBeNull();
});
