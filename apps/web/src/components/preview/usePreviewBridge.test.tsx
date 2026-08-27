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
  previewEnvironment: { reportStatus: {} },
}));
vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: () => mocks.reportStatus,
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
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
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
});
