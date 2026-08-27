// @vitest-environment happy-dom

import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  EnvironmentId,
  type PreviewListResult,
  type PreviewSessionSnapshot,
  ThreadId,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/unstable/reactivity";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => {
  const sessionsAtom = { kind: "preview-list" };
  const eventsAtom = { kind: "preview-events" };
  const local = {
    sessions: {} as Record<string, { readonly tabId: string }>,
  };
  return {
    sessionsAtom,
    eventsAtom,
    local,
    sessionsResult: undefined as unknown,
    list: vi.fn(() => sessionsAtom),
    events: vi.fn(() => eventsAtom),
    useAtomValue: vi.fn((atom: unknown) =>
      atom === sessionsAtom ? mocks.sessionsResult : undefined,
    ),
    readThreadPreviewState: vi.fn(() => ({
      serverEpoch: null,
      sessions: local.sessions,
    })),
    reconcilePreviewServerSessions: vi.fn(
      (
        _threadRef: unknown,
        result: { readonly sessions: ReadonlyArray<{ readonly tabId: string }> },
      ) => {
        local.sessions = Object.fromEntries(
          result.sessions.map((session) => [session.tabId, session]),
        );
      },
    ),
  };
});

vi.mock("@effect/atom-react", () => ({ useAtomValue: mocks.useAtomValue }));
vi.mock("~/state/preview", () => ({
  previewEnvironment: { list: mocks.list, events: mocks.events },
}));
vi.mock("~/previewStateStore", () => ({
  applyPreviewServerEvent: vi.fn(),
  readThreadPreviewState: mocks.readThreadPreviewState,
  reconcilePreviewServerSessions: mocks.reconcilePreviewServerSessions,
}));

import { usePreviewSession } from "./usePreviewSession";

const threadRef = scopeThreadRef(EnvironmentId.make("environment-1"), ThreadId.make("thread-1"));
const otherThreadRef = scopeThreadRef(
  EnvironmentId.make("environment-1"),
  ThreadId.make("thread-other"),
);
const serverEpoch = "server-a";
const snapshot: PreviewSessionSnapshot = {
  threadId: threadRef.threadId,
  tabId: "tab-automation",
  navStatus: { _tag: "Loading", url: "https://example.test/", title: "" },
  canGoBack: false,
  canGoForward: false,
  updatedAt: "2026-08-27T12:00:00.000Z",
};

const listResult = (
  sessions: ReadonlyArray<PreviewSessionSnapshot>,
  revision = 0,
): PreviewListResult => ({ sessions, serverEpoch, revision });

function SessionConsumer({
  renderVersion = 0,
  sessionThreadRef = threadRef,
}: {
  readonly renderVersion?: number;
  readonly sessionThreadRef?: typeof threadRef;
}) {
  usePreviewSession(sessionThreadRef);
  void renderVersion;
  return null;
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mocks.sessionsResult = AsyncResult.initial();
  mocks.local.sessions = {};
  mocks.list.mockClear();
  mocks.events.mockClear();
  mocks.useAtomValue.mockClear();
  mocks.readThreadPreviewState.mockClear();
  mocks.reconcilePreviewServerSessions.mockClear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("usePreviewSession", () => {
  it("mounts preview.list directly instead of waiting for the event sync atom", async () => {
    await act(async () => root.render(<SessionConsumer />));

    expect(mocks.list).toHaveBeenCalledWith({
      environmentId: "environment-1",
      input: { threadId: "thread-1" },
    });
    expect(mocks.useAtomValue).toHaveBeenCalledWith(mocks.sessionsAtom);
  });

  it("preserves a local automation tab from a cached empty list at the same revision", async () => {
    await act(async () => root.render(<SessionConsumer sessionThreadRef={otherThreadRef} />));

    mocks.local.sessions = { [snapshot.tabId]: snapshot };
    mocks.sessionsResult = AsyncResult.success(listResult([], 0));

    await act(async () => root.render(<SessionConsumer sessionThreadRef={threadRef} />));

    expect(mocks.reconcilePreviewServerSessions).not.toHaveBeenCalled();
    expect(mocks.local.sessions).toEqual({ [snapshot.tabId]: snapshot });
  });

  it("restores cached server tabs when local state is empty", async () => {
    const restored = listResult([snapshot], 1);
    mocks.sessionsResult = AsyncResult.success(restored);

    await act(async () => root.render(<SessionConsumer />));

    expect(mocks.reconcilePreviewServerSessions).toHaveBeenCalledWith(threadRef, restored);
    expect(mocks.local.sessions).toEqual({ [snapshot.tabId]: snapshot });
  });

  it("applies the authoritative empty list after the forced refresh completes", async () => {
    mocks.local.sessions = { [snapshot.tabId]: snapshot };
    mocks.sessionsResult = AsyncResult.success(listResult([], 0));
    await act(async () => root.render(<SessionConsumer />));

    mocks.sessionsResult = AsyncResult.success(listResult([], 1), { waiting: true });
    await act(async () => root.render(<SessionConsumer renderVersion={1} />));
    expect(mocks.reconcilePreviewServerSessions).not.toHaveBeenCalled();

    const refreshed = listResult([], 1);
    mocks.sessionsResult = AsyncResult.success(refreshed);
    await act(async () => root.render(<SessionConsumer renderVersion={2} />));

    expect(mocks.reconcilePreviewServerSessions).toHaveBeenCalledOnce();
    expect(mocks.reconcilePreviewServerSessions).toHaveBeenCalledWith(threadRef, refreshed);
    expect(mocks.local.sessions).toEqual({});
  });
});
