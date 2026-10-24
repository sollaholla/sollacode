// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

import {
  useStableLowContextWarningAction,
  type LowContextWarningAction,
} from "./useStableLowContextWarningAction";

async function observe(
  renders: ReadonlyArray<LowContextWarningAction | undefined>,
): Promise<ReadonlyArray<LowContextWarningAction | undefined>> {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const seen: Array<LowContextWarningAction | undefined> = [];
  function Probe(props: { readonly action: LowContextWarningAction | undefined }) {
    seen.push(useStableLowContextWarningAction(props.action));
    return null;
  }
  const root = createRoot(document.createElement("div"));
  try {
    for (const action of renders) {
      await act(async () => root.render(<Probe action={action} />));
    }
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
  return seen;
}

it("keeps one identity while the timeline rebuilds the object and the callback each render", async () => {
  const seen = await observe([
    { onCompactAndContinue: () => {}, busy: false },
    { onCompactAndContinue: () => {}, busy: false },
    { onCompactAndContinue: () => {}, busy: false },
  ]);
  expect(seen[0]).toBeDefined();
  expect(seen[1]).toBe(seen[0]);
  expect(seen[2]).toBe(seen[0]);
});

it("calls the latest callback through the stable wrapper", async () => {
  const first = vi.fn();
  const second = vi.fn();
  const seen = await observe([
    { onCompactAndContinue: first, busy: false },
    { onCompactAndContinue: second, busy: false },
  ]);
  seen[0]?.onCompactAndContinue();
  expect(first).not.toHaveBeenCalled();
  expect(second).toHaveBeenCalledOnce();
});

it("changes identity only when busy flips or the action appears or goes away", async () => {
  const callback = () => {};
  const seen = await observe([
    undefined,
    { onCompactAndContinue: callback, busy: false },
    { onCompactAndContinue: callback, busy: true },
    undefined,
  ]);
  expect(seen[0]).toBeUndefined();
  expect(seen[1]?.busy).toBe(false);
  expect(seen[2]?.busy).toBe(true);
  expect(seen[2]).not.toBe(seen[1]);
  expect(seen[3]).toBeUndefined();
});
