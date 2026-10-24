// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { useNowMinute, useNowMinuteValue } from "./useNowMinute";

let root: Root;
let selectedRenders = 0;
let minuteRenders = 0;
let latestSelected: boolean | undefined;
let latestMinute: string | undefined;

function SelectedProbe(props: { readonly threshold: string }) {
  latestSelected = useNowMinuteValue((nowMinute) => nowMinute >= props.threshold);
  selectedRenders += 1;
  return null;
}

function MinuteProbe() {
  latestMinute = useNowMinute();
  minuteRenders += 1;
  return null;
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers({ now: new Date("2026-01-01T00:00:30.000Z") });
  selectedRenders = 0;
  minuteRenders = 0;
  root = createRoot(document.createElement("div"));
});

afterEach(async () => {
  await act(() => root.unmount());
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("useNowMinuteValue", () => {
  it("re-renders when the selected value changes, not on every minute", async () => {
    await act(() =>
      root.render(
        createElement("div", null, [
          createElement(SelectedProbe, { key: "selected", threshold: "2026-01-01T00:03" }),
          createElement(MinuteProbe, { key: "minute" }),
        ]),
      ),
    );
    expect(latestSelected).toBe(false);
    const selectedBaseline = selectedRenders;
    const minuteBaseline = minuteRenders;

    // 00:01 and 00:02: the minute moves, the answer does not.
    await act(() => vi.advanceTimersByTime(30_000));
    expect(latestMinute).toBe("2026-01-01T00:01");
    await act(() => vi.advanceTimersByTime(60_000));
    expect(latestMinute).toBe("2026-01-01T00:02");
    expect(minuteRenders).toBe(minuteBaseline + 2);
    expect(selectedRenders).toBe(selectedBaseline);
    expect(latestSelected).toBe(false);

    // 00:03: the answer flips on the same tick the minute does.
    await act(() => vi.advanceTimersByTime(60_000));
    expect(latestMinute).toBe("2026-01-01T00:03");
    expect(latestSelected).toBe(true);
    expect(selectedRenders).toBe(selectedBaseline + 1);
  });
});
