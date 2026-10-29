// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { useUiStateStore } from "../uiStateStore";
import { useThreadVisitWatermark } from "./useThreadVisitWatermark";

let root: Root;
let renders = 0;
const openedAt = "2026-10-29T18:00:00.000Z";
const completedAt = "2026-10-29T18:01:00.000Z";
const wokeAt = "2026-10-29T18:02:00.000Z";

function Probe(props: Parameters<typeof useThreadVisitWatermark>[0]) {
  useThreadVisitWatermark(props);
  renders += 1;
  return null;
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  useUiStateStore.setState({ threadLastVisitedAtById: {} });
  renders = 0;
  root = createRoot(document.createElement("div"));
});

afterEach(async () => {
  await act(() => root.unmount());
  vi.unstubAllGlobals();
});

describe("useThreadVisitWatermark", () => {
  it("acknowledges open and completion without an extra render or per-delta writes", async () => {
    const props = { threadKey: "env:thread", updatedAt: openedAt, completedAt: null, wokeAt: null };
    await act(() => root.render(createElement(Probe, props)));
    expect(renders).toBe(1);
    const visits = useUiStateStore.getState().threadLastVisitedAtById;
    expect(visits[props.threadKey]).toBe(openedAt);

    for (let i = 1; i <= 20; i += 1) {
      await act(() =>
        root.render(
          createElement(Probe, {
            ...props,
            updatedAt: `2026-10-29T18:00:${String(i).padStart(2, "0")}.000Z`,
          }),
        ),
      );
    }
    expect(renders).toBe(21);
    expect(useUiStateStore.getState().threadLastVisitedAtById).toBe(visits);

    await act(() =>
      root.render(createElement(Probe, { ...props, updatedAt: completedAt, completedAt })),
    );
    expect(renders).toBe(22);
    expect(useUiStateStore.getState().threadLastVisitedAtById[props.threadKey]).toBe(completedAt);
  });

  it("keeps a manual unread mark until reopening or a new completion", async () => {
    const props = { threadKey: "env:thread", updatedAt: completedAt, completedAt, wokeAt: null };
    await act(() => root.render(createElement(Probe, props)));
    await act(() => useUiStateStore.getState().markThreadUnread(props.threadKey, completedAt));
    const unreadVisits = useUiStateStore.getState().threadLastVisitedAtById;
    expect(renders).toBe(1);
    await act(() => root.render(createElement(Probe, { ...props, updatedAt: wokeAt })));
    expect(useUiStateStore.getState().threadLastVisitedAtById).toBe(unreadVisits);

    await act(() => root.render(createElement(Probe, { ...props, threadKey: "other:thread" })));
    await act(() => root.render(createElement(Probe, { ...props, updatedAt: wokeAt })));
    expect(useUiStateStore.getState().threadLastVisitedAtById[props.threadKey]).toBe(wokeAt);
    expect(useUiStateStore.getState().threadLastVisitedAtById["other:thread"]).toBe(completedAt);
  });

  it("acknowledges timer wakes newer than the server update", async () => {
    const props = { threadKey: "env:thread", updatedAt: openedAt, completedAt: null, wokeAt: null };
    await act(() => root.render(createElement(Probe, props)));
    await act(() => root.render(createElement(Probe, { ...props, wokeAt })));
    expect(useUiStateStore.getState().threadLastVisitedAtById[props.threadKey]).toBe(wokeAt);
    expect(renders).toBe(2);
  });

  it("acknowledges a new turn when its completion timestamp resets", async () => {
    const props = { threadKey: "env:thread", updatedAt: completedAt, completedAt, wokeAt: null };
    await act(() => root.render(createElement(Probe, props)));
    await act(() => useUiStateStore.getState().markThreadUnread(props.threadKey, completedAt));
    await act(() =>
      root.render(createElement(Probe, { ...props, updatedAt: wokeAt, completedAt: null })),
    );
    expect(useUiStateStore.getState().threadLastVisitedAtById[props.threadKey]).toBe(wokeAt);
    expect(renders).toBe(2);
  });

  it("waits for a loaded thread and never moves an existing visit backwards", async () => {
    const props = { threadKey: null, updatedAt: undefined, completedAt: null, wokeAt: null };
    await act(() => root.render(createElement(Probe, props)));
    expect(useUiStateStore.getState().threadLastVisitedAtById).toEqual({});
    useUiStateStore.getState().markThreadVisited("env:thread", wokeAt);
    await act(() =>
      root.render(createElement(Probe, { ...props, threadKey: "env:thread", updatedAt: openedAt })),
    );
    expect(useUiStateStore.getState().threadLastVisitedAtById["env:thread"]).toBe(wokeAt);
  });
});
