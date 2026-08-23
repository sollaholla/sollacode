import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { selectThreadRightPanelState, useRightPanelStore } from "~/rightPanelStore";
import { reconcileHydratedBrowserSurfaces } from "./reconcileHydratedBrowserSurfaces";

const threadRef = scopeThreadRef(EnvironmentId.make("environment-1"), ThreadId.make("thread-1"));

beforeEach(() => {
  useRightPanelStore.setState({ byThreadKey: {}, pendingSideChatSpawnsByThreadKey: {} });
});

const surfaceIds = () =>
  selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, threadRef).surfaces.map(
    (surface) => surface.id,
  );

describe("reconcileHydratedBrowserSurfaces", () => {
  it("keeps restored Browser surfaces while the initial preview list is unresolved", () => {
    useRightPanelStore.getState().openBrowser(threadRef, "tab_1");

    reconcileHydratedBrowserSurfaces(threadRef, { serverEpoch: null, sessions: {} });

    expect(surfaceIds()).toEqual(["browser:tab_1"]);
  });

  it("reconciles Browser surfaces after the server list becomes authoritative", () => {
    useRightPanelStore.getState().openBrowser(threadRef, "stale_tab");

    reconcileHydratedBrowserSurfaces(threadRef, {
      serverEpoch: "server-after-restart",
      sessions: {
        tab_1: {
          threadId: threadRef.threadId,
          tabId: "tab_1",
          navStatus: { _tag: "Success", url: "https://example.com", title: "Restored" },
          canGoBack: false,
          canGoForward: false,
          updatedAt: "2026-08-23T20:00:00.000Z",
        },
      },
    });

    expect(surfaceIds()).toEqual(["browser:tab_1"]);
  });
});
