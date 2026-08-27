import { describe, expect, it, vi } from "@effect/vitest";
import { EnvironmentId, PreviewTabId, ThreadId } from "@t3tools/contracts";

import { closeRemoteBrowserTab, openRemoteBrowserTab } from "./threadBrowserRouteActions";

const environmentId = EnvironmentId.make("environment-1");
const threadId = ThreadId.make("thread-1");
const tabId = PreviewTabId.make("tab-1");

describe("mobile host browser route actions", () => {
  it("opens a tab through the remote environment and selects the returned tab", async () => {
    const open = vi.fn(async () => ({ _tag: "Success" as const, value: { tabId } }));
    const onOpened = vi.fn();
    const refresh = vi.fn();

    await openRemoteBrowserTab({
      environmentId,
      threadId,
      open,
      onOpened,
      refresh,
      onFailure: vi.fn(),
    });

    expect(open).toHaveBeenCalledWith({ environmentId, input: { threadId } });
    expect(onOpened).toHaveBeenCalledWith(tabId);
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("closes the selected host tab and refreshes the remote list", async () => {
    const close = vi.fn(async () => ({ _tag: "Success" as const, value: undefined }));
    const onClosed = vi.fn();
    const refresh = vi.fn();

    await closeRemoteBrowserTab({
      environmentId,
      threadId,
      tabId,
      close,
      onClosed,
      refresh,
      onFailure: vi.fn(),
    });

    expect(close).toHaveBeenCalledWith({ environmentId, input: { threadId, tabId } });
    expect(onClosed).toHaveBeenCalledOnce();
    expect(refresh).toHaveBeenCalledOnce();
  });
});
