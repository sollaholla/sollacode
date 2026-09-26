import { describe, expect, it } from "vite-plus/test";
import {
  isRoutineMusePollingNotice,
  recoveredRuntimeErrorIds,
  isSideChatSessionPreparing,
  isThreadSessionWorking,
  canResumeFailedThreadSession,
} from "./threadActivity.ts";

describe("side chat session preparation", () => {
  const blank = {
    isSideChat: true,
    session: { status: "starting", activeTurnId: null },
    latestTurn: null,
    pendingWork: null,
  };

  it("keeps a blank fork sendable even when a failed initializer left starting behind", () => {
    expect(isSideChatSessionPreparing(blank)).toBe(true);
    expect(isThreadSessionWorking(blank)).toBe(false);
  });

  it("reports actual queued, starting and running work as busy", () => {
    for (const thread of [
      { ...blank, isSideChat: false },
      { ...blank, latestTurn: { state: "running" } },
      { ...blank, pendingWork: { state: "pending" } },
      { ...blank, session: { status: "starting", activeTurnId: "first-turn" } },
      { ...blank, session: { status: "running", activeTurnId: null } },
    ]) {
      expect(isSideChatSessionPreparing(thread)).toBe(false);
      expect(isThreadSessionWorking(thread)).toBe(true);
    }
  });

  it("leaves disconnected, ready and stopped conversations idle", () => {
    expect(isThreadSessionWorking(undefined)).toBe(false);
    for (const status of ["ready", "error", "stopped", "interrupted"]) {
      expect(isThreadSessionWorking({ ...blank, session: { status } })).toBe(false);
    }
  });
});

describe("failed session resume", () => {
  const failed = {
    session: {
      status: "error",
      activeTurnId: null,
      lastError:
        "The provider received your message, but its turn state was lost. Use Resume to continue.",
    },
    pendingWork: null,
  };
  it("offers recovery with no assistant or error activity and a completed predecessor", () => {
    expect(
      canResumeFailedThreadSession({
        ...failed,
        latestTurn: { state: "completed" },
      } as typeof failed),
    ).toBe(true);
  });
  it("offers an explicit Resume when startup stopped a session but retained its error", () => {
    for (const status of ["stopped", "interrupted"])
      expect(
        canResumeFailedThreadSession({ ...failed, session: { ...failed.session, status } }),
      ).toBe(true);
  });
  it("does not duplicate active work or offer error recovery after a clean stop", () => {
    expect(canResumeFailedThreadSession({ ...failed, pendingWork: { state: "pending" } })).toBe(
      false,
    );
    for (const session of [
      { ...failed.session, activeTurnId: "native-turn" },
      { ...failed.session, status: "running" },
      { ...failed.session, status: "stopped", lastError: null },
      { ...failed.session, lastError: null },
    ])
      expect(canResumeFailedThreadSession({ ...failed, session })).toBe(false);
  });
});

describe("routine Muse polling notice", () => {
  const notice =
    "Muse live streaming is unavailable for this saved session. Activity will refresh every five seconds.";
  it("recognizes persisted summary and payload forms", () => {
    expect(isRoutineMusePollingNotice({ kind: "runtime.warning", summary: notice })).toBe(true);
    expect(
      isRoutineMusePollingNotice({
        kind: "runtime.warning",
        summary: "Runtime warning",
        payload: { message: notice },
      }),
    ).toBe(true);
  });
  it("hides only the recovered stale-anchor reattachment warning", () => {
    const summary = "Muse live streaming could not be reattached.";
    expect(
      isRoutineMusePollingNotice({
        kind: "runtime.warning",
        summary,
        payload: { detail: "ProviderAdapterRequestError: muse:notFound: unknown cursor anchor" },
      }),
    ).toBe(true);
    expect(
      isRoutineMusePollingNotice({
        kind: "runtime.warning",
        summary,
        payload: { detail: "authorization denied" },
      }),
    ).toBe(false);
    expect(
      isRoutineMusePollingNotice({
        kind: "runtime.error",
        summary,
        payload: { detail: "unknown cursor anchor" },
      }),
    ).toBe(false);
  });
  it("keeps actual failures and other provider warnings visible", () => {
    expect(isRoutineMusePollingNotice({ kind: "runtime.error", summary: notice })).toBe(false);
    expect(
      isRoutineMusePollingNotice({
        kind: "runtime.warning",
        summary: "Muse request failed: insufficient credits",
      }),
    ).toBe(false);
    expect(
      isRoutineMusePollingNotice({
        kind: "runtime.warning",
        summary: "Provider request is retrying",
      }),
    ).toBe(false);
  });
});

describe("recovered runtime errors", () => {
  it("matches the exact successful recovery receipt even when its error text was truncated", () => {
    const recovered = recoveredRuntimeErrorIds([
      { id: "agy:277:provider.failover.completed", kind: "provider.failover.completed" },
      { id: "agy:300:provider.failover.completed", kind: "provider.failover.completed" },
      { id: "failed:provider.failover.unavailable", kind: "provider.failover.unavailable" },
      { id: "pretend:provider.failover.completed", kind: "tool.completed" },
    ]);
    expect([...recovered]).toEqual(["agy:277", "agy:300"]);
    expect(recovered.has("unrelated-error-same-turn")).toBe(false);
    expect(recovered.has("failed")).toBe(false);
  });
});
