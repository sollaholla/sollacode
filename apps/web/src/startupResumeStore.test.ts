import { beforeEach, describe, expect, it } from "vite-plus/test";

import { useStartupResumeStore } from "./startupResumeStore";

describe("startup resume visibility", () => {
  beforeEach(() => {
    useStartupResumeStore.setState({ pendingStartedAtByThreadKey: {} });
  });

  it("marks every submitted thread until that exact submission settles", () => {
    const store = useStartupResumeStore.getState();
    store.markPending(["env:main", "env:side"], "2026-08-03T12:00:00.000Z");
    expect(useStartupResumeStore.getState().pendingStartedAtByThreadKey).toEqual({
      "env:main": "2026-08-03T12:00:00.000Z",
      "env:side": "2026-08-03T12:00:00.000Z",
    });

    useStartupResumeStore.getState().clearPending("env:side");
    expect(useStartupResumeStore.getState().pendingStartedAtByThreadKey).toEqual({
      "env:main": "2026-08-03T12:00:00.000Z",
    });
  });

  it("keeps the original start time when another client submits the same resume", () => {
    const store = useStartupResumeStore.getState();
    store.markPending(["env:thread"], "2026-08-03T12:00:00.000Z");
    useStartupResumeStore.getState().markPending(["env:thread"], "2026-08-03T12:01:00.000Z");
    expect(useStartupResumeStore.getState().pendingStartedAtByThreadKey["env:thread"]).toBe(
      "2026-08-03T12:00:00.000Z",
    );
  });
});
