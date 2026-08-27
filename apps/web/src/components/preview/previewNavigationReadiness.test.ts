import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  readThreadPreviewState: vi.fn(),
}));

vi.mock("~/previewStateStore", () => ({
  applyPreviewServerSnapshot: vi.fn(),
  readThreadPreviewState: mocks.readThreadPreviewState,
  reconcilePreviewServerSessions: vi.fn(),
  updatePreviewServerSnapshot: vi.fn(),
}));

vi.mock("./previewBridge", () => ({
  previewBridge: {
    automation: {
      evaluate: vi.fn(),
      status: vi.fn(),
    },
  },
}));

import { previewRuntimeTabId } from "~/browser/previewRuntimeTabId";

import { previewBridge } from "./previewBridge";
import {
  isPreviewAutomationHostError,
  PreviewAutomationNavigationLoadFailedHostError,
  PreviewAutomationTargetUnavailableError,
} from "./previewAutomationErrors";
import { waitForNavigationReadiness } from "./previewNavigationReadiness";

describe("waitForNavigationReadiness", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects a replaced runtime target even when readiness polling is disabled", async () => {
    const threadRef = {
      environmentId: EnvironmentId.make("environment-2"),
      threadId: ThreadId.make("thread-1"),
    };
    const tabId = "tab_1";
    const staleRuntimeTabId = previewRuntimeTabId(threadRef, "epoch-1", tabId);
    mocks.readThreadPreviewState.mockReturnValue({
      serverEpoch: "epoch-2",
      sessions: {
        [tabId]: { tabId },
      },
    });

    await expect(
      waitForNavigationReadiness(
        threadRef,
        "request-1",
        tabId,
        staleRuntimeTabId,
        "navigate",
        "none",
        100,
      ),
    ).rejects.toBeInstanceOf(PreviewAutomationTargetUnavailableError);
  });

  it("keeps a durable hosted guest automatable while server metadata reconnects", async () => {
    const threadRef = {
      environmentId: EnvironmentId.make("environment-2"),
      threadId: ThreadId.make("thread-1"),
    };
    const tabId = "tab_9be1ed02-7d29-4b42-b73b-ebbe32462445";
    const runtimeTabId = previewRuntimeTabId(threadRef, "epoch-1", tabId);
    mocks.readThreadPreviewState.mockReturnValue({
      serverEpoch: "epoch-2",
      sessions: {},
      hostedSessions: { [tabId]: { tabId } },
    });

    await expect(
      waitForNavigationReadiness(
        threadRef,
        "request-1",
        tabId,
        runtimeTabId,
        "navigate",
        "none",
        100,
      ),
    ).resolves.toBeUndefined();
  });

  it.each(["load", "domContentLoaded"] as const)(
    "fails immediately and actionably when %s readiness reports a navigation failure",
    async (readiness) => {
      const threadRef = {
        environmentId: EnvironmentId.make("environment-2"),
        threadId: ThreadId.make("thread-1"),
      };
      const tabId = "tab_1";
      const runtimeTabId = previewRuntimeTabId(threadRef, "epoch-1", tabId);
      mocks.readThreadPreviewState.mockReturnValue({
        serverEpoch: "epoch-1",
        sessions: {
          [tabId]: { tabId },
        },
      });
      vi.mocked(previewBridge!.automation.status).mockResolvedValue({
        available: true,
        visible: false,
        tabId: runtimeTabId,
        url: "https://example.invalid",
        title: "",
        loading: false,
        loadFailure: {
          code: -105,
          description: "ERR_NAME_NOT_RESOLVED",
        },
      });

      const failure = await waitForNavigationReadiness(
        threadRef,
        "request-failed-navigation",
        tabId,
        runtimeTabId,
        "navigate",
        readiness,
        10_000,
      ).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(PreviewAutomationNavigationLoadFailedHostError);
      if (
        !isPreviewAutomationHostError(failure) ||
        failure._tag !== "PreviewAutomationNavigationLoadFailedHostError"
      ) {
        throw failure;
      }
      expect(failure).toMatchObject({
        responseTag: "PreviewAutomationExecutionError",
        code: -105,
        description: "ERR_NAME_NOT_RESOLVED",
      });
      expect(failure.message).toContain("Correct the URL or underlying network/site error");
      expect(previewBridge!.automation.status).toHaveBeenCalledTimes(1);
      expect(previewBridge!.automation.evaluate).not.toHaveBeenCalled();
    },
  );

  it("does not accept the previous document's readyState while the target is loading", async () => {
    const threadRef = {
      environmentId: EnvironmentId.make("environment-2"),
      threadId: ThreadId.make("thread-1"),
    };
    const tabId = "tab_1";
    const runtimeTabId = previewRuntimeTabId(threadRef, "epoch-1", tabId);
    mocks.readThreadPreviewState.mockReturnValue({
      serverEpoch: "epoch-1",
      sessions: {
        [tabId]: { tabId },
      },
    });
    vi.mocked(previewBridge!.automation.status)
      .mockResolvedValueOnce({
        available: true,
        visible: false,
        tabId: runtimeTabId,
        url: "https://youtube.com/",
        title: "TikTok",
        loading: true,
      })
      .mockResolvedValueOnce({
        available: true,
        visible: false,
        tabId: runtimeTabId,
        url: "https://youtube.com/",
        title: "YouTube",
        loading: false,
      });
    vi.mocked(previewBridge!.automation.evaluate).mockResolvedValue("complete");

    await waitForNavigationReadiness(
      threadRef,
      "request-new-document",
      tabId,
      runtimeTabId,
      "navigate",
      "domContentLoaded",
      1_000,
    );

    expect(previewBridge!.automation.status).toHaveBeenCalledTimes(2);
    expect(previewBridge!.automation.evaluate).toHaveBeenCalledOnce();
  });
});
