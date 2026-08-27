// @vitest-environment happy-dom

import { EnvironmentId } from "@t3tools/contracts";
import { AsyncResult } from "effect/unstable/reactivity";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => {
  const sessionsAtom = { kind: "environment-preview-list" };
  const eventsAtom = { kind: "environment-preview-events" };
  return {
    sessionsAtom,
    eventsAtom,
    sessionsResult: undefined as unknown,
    applyPreviewServerEvent: vi.fn(),
    reconcilePreviewEnvironmentSessions: vi.fn(),
    refreshSessions: vi.fn(async () => undefined),
    list: vi.fn(() => sessionsAtom),
    events: vi.fn(() => eventsAtom),
    useAtomValue: vi.fn((atom: unknown) =>
      atom === sessionsAtom ? mocks.sessionsResult : undefined,
    ),
    useAtomRefresh: vi.fn((atom: unknown) => {
      if (atom !== sessionsAtom) throw new Error("unexpected refresh atom");
      return mocks.refreshSessions;
    }),
  };
});

vi.mock("@effect/atom-react", () => ({
  useAtomRefresh: mocks.useAtomRefresh,
  useAtomValue: mocks.useAtomValue,
}));
vi.mock("~/env", () => ({ isElectron: true }));
vi.mock("~/state/environments", () => ({
  useEnvironments: () => ({
    environments: [{ environmentId: "environment-a" }],
  }),
}));
vi.mock("~/state/preview", () => ({
  previewEnvironment: { events: mocks.events, list: mocks.list },
}));

vi.mock("~/previewStateStore", () => ({
  applyPreviewServerEvent: mocks.applyPreviewServerEvent,
  reconcilePreviewEnvironmentSessions: mocks.reconcilePreviewEnvironmentSessions,
}));

import {
  applyPreviewEventForEnvironment,
  applyPreviewListForEnvironment,
  PreviewEventHosts,
} from "./PreviewEventHosts";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mocks.applyPreviewServerEvent.mockClear();
  mocks.reconcilePreviewEnvironmentSessions.mockClear();
  mocks.refreshSessions.mockClear();
  mocks.list.mockClear();
  mocks.events.mockClear();
  mocks.useAtomValue.mockClear();
  mocks.useAtomRefresh.mockClear();
  mocks.sessionsResult = AsyncResult.initial();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("applyPreviewEventForEnvironment", () => {
  it("routes a background event to the thread that owns the tab", () => {
    const environmentId = EnvironmentId.make("environment-a");
    const event = {
      type: "opened" as const,
      threadId: "thread-background",
      tabId: "tab_a",
      createdAt: "2026-08-27T12:00:00.000Z",
      serverEpoch: "server-a",
      revision: 1,
      snapshot: {
        threadId: "thread-background",
        tabId: "tab_a",
        navStatus: { _tag: "Idle" as const },
        canGoBack: false,
        canGoForward: false,
        updatedAt: "2026-08-27T12:00:00.000Z",
      },
    };

    applyPreviewEventForEnvironment(environmentId, event);

    expect(mocks.applyPreviewServerEvent).toHaveBeenCalledWith(
      { environmentId, threadId: "thread-background" },
      event,
    );
  });
});

describe("applyPreviewListForEnvironment", () => {
  it("routes an environment-wide reconnect snapshot to the guest registry", () => {
    const environmentId = EnvironmentId.make("environment-a");
    const result = {
      sessions: [],
      serverEpoch: "server-b",
      revision: 7,
    };

    applyPreviewListForEnvironment(environmentId, result);

    expect(mocks.reconcilePreviewEnvironmentSessions).toHaveBeenCalledWith(environmentId, result);
  });

  it("mounts the global list query directly and adopts only its fresh settled result", async () => {
    const cached = { sessions: [], serverEpoch: "server-a", revision: 1 };
    mocks.sessionsResult = AsyncResult.success(cached);

    await act(async () => root.render(createElement(PreviewEventHosts)));

    expect(mocks.useAtomValue).toHaveBeenCalledWith(mocks.sessionsAtom);
    expect(mocks.refreshSessions).toHaveBeenCalledOnce();
    expect(mocks.reconcilePreviewEnvironmentSessions).not.toHaveBeenCalled();

    const fresh = { sessions: [], serverEpoch: "server-b", revision: 2 };
    mocks.sessionsResult = AsyncResult.success(fresh, { waiting: true });
    await act(async () => root.render(createElement(PreviewEventHosts)));
    expect(mocks.reconcilePreviewEnvironmentSessions).not.toHaveBeenCalled();

    mocks.sessionsResult = AsyncResult.success(fresh);
    await act(async () => root.render(createElement(PreviewEventHosts)));
    expect(mocks.reconcilePreviewEnvironmentSessions).toHaveBeenCalledOnce();
    expect(mocks.reconcilePreviewEnvironmentSessions).toHaveBeenCalledWith(
      EnvironmentId.make("environment-a"),
      fresh,
    );
  });
});
