// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import { ThreadErrorBanner } from "./ThreadErrorBanner";

let root: Root;
let container: HTMLElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers({ now: new Date("2026-01-01T00:10:30.000Z") });
  container = document.createElement("div");
  root = createRoot(container);
});

afterEach(async () => {
  await act(() => root.unmount());
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("advances the failure age while the banner stays on screen", async () => {
  await act(() =>
    root.render(
      createElement(ThreadErrorBanner, {
        error: "Provider failed",
        occurredAt: "2026-01-01T00:00:00.000Z",
      }),
    ),
  );
  expect(container.textContent).toContain("Last failed 10 minutes ago.");

  await act(() => vi.advanceTimersByTime(3 * 60_000));
  expect(container.textContent).toContain("Last failed 13 minutes ago.");
});
