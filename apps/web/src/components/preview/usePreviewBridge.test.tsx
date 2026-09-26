// @vitest-environment happy-dom

import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { type DesktopPreviewTabState, EnvironmentId, ThreadId } from "@t3tools/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => {
  let listener: ((tabId: string, state: DesktopPreviewTabState) => void) | null = null;
  return {
    applyPreviewDesktopState: vi.fn(),
    clearBrowserPointer: vi.fn(),
    onStateChange: vi.fn((next: typeof listener) => {
      listener = next;
      return () => {
        if (listener === next) listener = null;
      };
    }),
    reportStatus: vi.fn(),
    reportActivity: vi.fn(),
    verification: null as { state: "human_verification_required" } | null,
    emit(tabId: string, state: DesktopPreviewTabState) {
      listener?.(tabId, state);
    },
  };
});

vi.mock("./previewBridge", () => ({
  previewBridge: { onStateChange: mocks.onStateChange },
}));
vi.mock("~/browser/browserPointerStore", () => ({
  useBrowserPointerStore: (
    select: (state: { clear: typeof mocks.clearBrowserPointer }) => unknown,
  ) => select({ clear: mocks.clearBrowserPointer }),
}));
vi.mock("~/previewStateStore", () => ({
  applyPreviewDesktopState: mocks.applyPreviewDesktopState,
}));
vi.mock("~/state/preview", () => ({
  previewEnvironment: { reportStatus: "status", reportActivity: "activity" },
}));
vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: (command: string) =>
    command === "activity" ? mocks.reportActivity : mocks.reportStatus,
}));

vi.mock("./previewHumanVerification", () => ({
  usePreviewHumanVerification: () => mocks.verification,
}));

import { usePreviewBridge } from "./usePreviewBridge";

const threadRef = scopeThreadRef(EnvironmentId.make("environment-1"), ThreadId.make("thread-1"));
const tabId = "tab_9be1ed02-7d29-4b42-b73b-ebbe32462445";
const runtimeTabId = "environment-1:thread-1:tab_9be1ed02-7d29-4b42-b73b-ebbe32462445";
const state: DesktopPreviewTabState = {
  tabId: runtimeTabId,
  webContentsId: 42,
  snapshotStageId: null,
  navStatus: { kind: "Success", url: "https://example.test/", title: "Example" },
  canGoBack: false,
  canGoForward: false,
  zoomFactor: 1,
  pictureInPicture: false,
  colorScheme: "system",
  controller: "none",
  agentActive: false,
  downloads: [],
  pendingDownloadApprovals: [],
  updatedAt: "2026-08-27T12:00:00.000Z",
};

function BridgeConsumer({ syncGeneration }: { readonly syncGeneration: number }) {
  usePreviewBridge({ threadRef, tabId, runtimeTabId, syncGeneration });
  return null;
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mocks.applyPreviewDesktopState.mockClear();
  mocks.clearBrowserPointer.mockClear();
  mocks.onStateChange.mockClear();
  mocks.reportStatus.mockReset();
  mocks.reportActivity.mockReset().mockResolvedValue({ _tag: "Success" });
  mocks.verification = null;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("usePreviewBridge", () => {
  it("retries a failed status and reports the same state after reconnect sync", async () => {
    mocks.reportStatus
      .mockResolvedValueOnce({ _tag: "Failure" })
      .mockResolvedValue({ _tag: "Success" });

    await act(async () => root.render(<BridgeConsumer syncGeneration={0} />));
    await act(async () => mocks.emit(runtimeTabId, state));
    expect(mocks.reportStatus).toHaveBeenCalledOnce();

    await act(async () => mocks.emit(runtimeTabId, state));
    expect(mocks.reportStatus).toHaveBeenCalledTimes(2);

    await act(async () => root.render(<BridgeConsumer syncGeneration={1} />));
    await act(async () => mocks.emit(runtimeTabId, state));
    expect(mocks.reportStatus).toHaveBeenCalledTimes(3);
    expect(mocks.reportStatus).toHaveBeenLastCalledWith({
      environmentId: threadRef.environmentId,
      input: expect.objectContaining({
        threadId: threadRef.threadId,
        tabId,
        navStatus: expect.objectContaining({
          _tag: "Success",
          url: "https://example.test/",
        }),
      }),
    });
  });

  it("does not drop the agent cursor when the same URL starts loading", async () => {
    mocks.reportStatus.mockResolvedValue({ _tag: "Success" });
    await act(async () => root.render(<BridgeConsumer syncGeneration={0} />));
    await act(async () => mocks.emit(runtimeTabId, state));
    await act(async () =>
      mocks.emit(runtimeTabId, {
        ...state,
        navStatus: { kind: "Loading", url: "https://example.test/", title: "Example" },
      }),
    );
    expect(mocks.clearBrowserPointer).not.toHaveBeenCalled();

    await act(async () =>
      mocks.emit(runtimeTabId, {
        ...state,
        navStatus: { kind: "Loading", url: "https://other.test/", title: "Other" },
      }),
    );
    expect(mocks.clearBrowserPointer).toHaveBeenCalledWith(runtimeTabId);
  });
});

it("reports user input with a trailing update, without treating page status as interaction", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-22T12:00:00.000Z"));
  mocks.reportStatus.mockResolvedValue({ _tag: "Success" });
  await act(async () => root.render(<BridgeConsumer syncGeneration={0} />));
  await act(async () => mocks.emit(runtimeTabId, state));
  expect(mocks.reportActivity).toHaveBeenLastCalledWith(
    expect.objectContaining({
      input: expect.objectContaining({ interacted: false, attentionRequired: false }),
    }),
  );
  mocks.reportActivity.mockClear();
  await act(async () =>
    mocks.emit(runtimeTabId, { ...state, updatedAt: new Date().toISOString() }),
  );
  expect(mocks.reportActivity).not.toHaveBeenCalled();
  await act(async () =>
    mocks.emit(runtimeTabId, { ...state, lastInteractionAt: new Date().toISOString() }),
  );
  expect(mocks.reportActivity).toHaveBeenCalledOnce();
  await act(async () => vi.advanceTimersByTime(5_000));
  await act(async () =>
    mocks.emit(runtimeTabId, { ...state, lastInteractionAt: new Date().toISOString() }),
  );
  expect(mocks.reportActivity).toHaveBeenCalledOnce();
  await act(async () => vi.advanceTimersByTime(10_000));
  expect(mocks.reportActivity).toHaveBeenCalledTimes(2);
  expect(mocks.reportActivity).toHaveBeenLastCalledWith({
    environmentId: threadRef.environmentId,
    input: { threadId: threadRef.threadId, tabId, interacted: true },
  });
});

it("keeps a human-verification gate protected and clears it after resolution", async () => {
  mocks.reportStatus.mockResolvedValue({ _tag: "Success" });
  mocks.verification = { state: "human_verification_required" };
  await act(async () => root.render(<BridgeConsumer syncGeneration={0} />));
  await act(async () => mocks.emit(runtimeTabId, state));
  expect(mocks.reportActivity).toHaveBeenLastCalledWith(
    expect.objectContaining({
      input: expect.objectContaining({ interacted: false, attentionRequired: true }),
    }),
  );
  mocks.verification = null;
  await act(async () => root.render(<BridgeConsumer syncGeneration={0} />));
  expect(mocks.reportActivity).toHaveBeenLastCalledWith(
    expect.objectContaining({
      input: expect.objectContaining({ interacted: false, attentionRequired: false }),
    }),
  );
});

it("protects pending downloads until the user answers", async () => {
  mocks.reportStatus.mockResolvedValue({ _tag: "Success" });
  await act(async () => root.render(<BridgeConsumer syncGeneration={0} />));
  await act(async () =>
    mocks.emit(runtimeTabId, {
      ...state,
      pendingDownloadApprovals: [
        { id: "download", domain: "example.test", fileName: "report.pdf" },
      ],
    }),
  );
  expect(mocks.reportActivity).toHaveBeenLastCalledWith(
    expect.objectContaining({
      input: expect.objectContaining({ interacted: false, attentionRequired: true }),
    }),
  );
  await act(async () => mocks.emit(runtimeTabId, state));
  expect(mocks.reportActivity).toHaveBeenLastCalledWith(
    expect.objectContaining({
      input: expect.objectContaining({ interacted: false, attentionRequired: false }),
    }),
  );
});

it("tells the server who drives the tab, so a phone's tab strip can show it", async () => {
  mocks.reportStatus.mockResolvedValue({ _tag: "Success" });
  const controlReports = () =>
    mocks.reportActivity.mock.calls.flatMap(([call]) =>
      call.input.agentControl === undefined ? [] : [call.input.agentControl],
    );
  await act(async () => root.render(<BridgeConsumer syncGeneration={0} />));
  await act(async () => mocks.emit(runtimeTabId, state));
  await act(async () => mocks.emit(runtimeTabId, { ...state, agentActive: true }));
  // Sticky between the agent's actions: a second event is not a second report.
  await act(async () =>
    mocks.emit(runtimeTabId, { ...state, controller: "agent", agentActive: true }),
  );
  await act(async () =>
    mocks.emit(runtimeTabId, { ...state, controller: "waiting-for-user", agentActive: true }),
  );
  expect(controlReports()).toEqual(["none", "agent", "waiting-for-user"]);

  // A reconnected server may hold a stale answer; report the current one again.
  await act(async () => root.render(<BridgeConsumer syncGeneration={1} />));
  await act(async () =>
    mocks.emit(runtimeTabId, { ...state, controller: "waiting-for-user", agentActive: true }),
  );
  expect(controlReports()).toEqual(["none", "agent", "waiting-for-user", "waiting-for-user"]);
});
