import { describe, expect, it } from "vite-plus/test";
import {
  isReasoningStatusPlaceholder,
  isRoutineMusePollingNotice,
  classifyThreadPause,
  describeThreadPause,
  isSideChatSessionPreparing,
  isThreadSessionWorking,
  canResumeFailedThreadSession,
  otherThreadsPausedOn,
  describeRunningBackgroundTasks,
  liveBackgroundTasks,
} from "./threadActivity.ts";

describe("reasoning status placeholders", () => {
  it.each([undefined, null, {}, { title: "Thinking" }, { detail: " \n " }, { detail: "Thinking" }])(
    "hides generic Thinking receipts with payload %s",
    (payload) => {
      expect(
        isReasoningStatusPlaceholder({ kind: "reasoning.updated", summary: "Thinking", payload }),
      ).toBe(true);
    },
  );

  it("recognizes Generating receipts but preserves actual thoughts and titled status", () => {
    expect(
      isReasoningStatusPlaceholder({
        kind: "reasoning.updated",
        summary: "Generating",
        payload: { title: "Generating", detail: "Generating" },
      }),
    ).toBe(true);
    for (const payload of [
      { detail: "Checking the scene" },
      { title: "Inspecting files" },
      { title: "Thinking", detail: "Checking the scene" },
    ]) {
      expect(
        isReasoningStatusPlaceholder({ kind: "reasoning.updated", summary: "Thinking", payload }),
      ).toBe(false);
    }
    expect(
      isReasoningStatusPlaceholder({ kind: "reasoning.updated", summary: "Inspecting files" }),
    ).toBe(false);
  });

  it("never hides tool, failure, or provider transition receipts", () => {
    for (const kind of ["tool.completed", "runtime.error", "thread.settings.applied"]) {
      expect(isReasoningStatusPlaceholder({ kind, summary: "Thinking" })).toBe(false);
    }
  });
});

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

describe("background tasks after the turn settled", () => {
  const nowMs = Date.parse("2026-10-10T12:00:00.000Z");
  const busy = {
    session: { status: "ready" },
    backgroundTasks: {
      count: 4,
      startedAt: "2026-10-10T11:40:00.000Z",
      lastActivityAt: "2026-10-10T11:59:30.000Z",
    },
  };

  it("counts work its provider is still reporting", () => {
    expect(liveBackgroundTasks(busy, nowMs)).toEqual({
      count: 4,
      startedAt: "2026-10-10T11:40:00.000Z",
    });
  });

  it("drops work whose process is gone or that has gone quiet", () => {
    expect(liveBackgroundTasks({ ...busy, session: { status: "stopped" } }, nowMs)).toBeNull();
    expect(
      liveBackgroundTasks(
        {
          ...busy,
          backgroundTasks: { ...busy.backgroundTasks, lastActivityAt: "2026-10-10T11:29:00.000Z" },
        },
        nowMs,
      ),
    ).toBeNull();
    expect(liveBackgroundTasks({ session: busy.session, backgroundTasks: null }, nowMs)).toBeNull();
    // Servers predating the summary send nothing at all.
    expect(liveBackgroundTasks({ session: busy.session }, nowMs)).toBeNull();
  });

  it("names the work in the transcript", () => {
    expect(describeRunningBackgroundTasks(1)).toBe("1 background task running");
    expect(describeRunningBackgroundTasks(4)).toBe("4 background tasks running");
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

describe("thread pause", () => {
  it("reads why a provider stopped from its own words", () => {
    expect(classifyThreadPause("You've hit your usage limit")).toBe("usage-limit");
    expect(classifyThreadPause("HTTP 429: too many requests")).toBe("usage-limit");
    expect(classifyThreadPause("HTTP 402 Payment Required")).toBe("out-of-credits");
    expect(classifyThreadPause("403 Forbidden")).toBe("access-refused");
    expect(classifyThreadPause("model not found: grok-retired")).toBe("model-unavailable");
    expect(classifyThreadPause("API error: 503 service unavailable")).toBe("provider-unavailable");
    expect(classifyThreadPause("something else went wrong")).toBe("stopped");
  });

  it("says it in one short line", () => {
    expect(describeThreadPause("usage-limit", "Claude")).toBe("Claude is out of usage");
    expect(describeThreadPause("model-unavailable", "Claude")).toBe("This model isn't available");
  });
});

describe("otherThreadsPausedOn", () => {
  const paused = { threadId: "here", instanceId: "claude", model: "opus" };
  const thread = (id: string, overrides: Record<string, unknown> = {}) => ({
    id,
    archivedAt: null,
    modelSelection: { instanceId: "claude", model: "opus" },
    session: { status: "error", activeTurnId: null, lastError: "You hit your limit" },
    pendingWork: null,
    ...overrides,
  });

  it("finds the other chats the same fix brings back", () => {
    expect(
      otherThreadsPausedOn([thread("here"), thread("a"), thread("b")], paused).map(({ id }) => id),
    ).toEqual(["a", "b"]);
  });

  it("leaves out other models, archives, queued work, and chats still running", () => {
    expect(
      otherThreadsPausedOn(
        [
          thread("model", { modelSelection: { instanceId: "claude", model: "sonnet" } }),
          thread("account", { modelSelection: { instanceId: "claude_work", model: "opus" } }),
          thread("archived", { archivedAt: "2026-11-01T00:00:00.000Z" }),
          thread("queued", { pendingWork: {} }),
          thread("running", { session: { status: "running", activeTurnId: "t", lastError: null } }),
        ],
        paused,
      ),
    ).toEqual([]);
  });

  it("leaves a chat the person stopped themselves", () => {
    expect(
      otherThreadsPausedOn(
        [thread("stopped", { session: { status: "stopped", lastError: "Stopped" } })],
        paused,
      ),
    ).toEqual([]);
  });
});
