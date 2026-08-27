import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  applyPreviewServerEvent: vi.fn(),
  reconcilePreviewEnvironmentSessions: vi.fn(),
}));

vi.mock("~/previewStateStore", () => ({
  applyPreviewServerEvent: mocks.applyPreviewServerEvent,
  reconcilePreviewEnvironmentSessions: mocks.reconcilePreviewEnvironmentSessions,
}));

import {
  applyPreviewEventForEnvironment,
  applyPreviewListForEnvironment,
} from "./PreviewEventHosts";

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
});
