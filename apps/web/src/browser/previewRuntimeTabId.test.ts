import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { isCurrentPreviewRuntimeTab, previewRuntimeTabId } from "./previewRuntimeTabId";

describe("previewRuntimeTabId", () => {
  const durableTabId = "tab_9be1ed02-7d29-4b42-b73b-ebbe32462445";

  it("scopes durable tab ids to their environment and thread", () => {
    const base = {
      environmentId: EnvironmentId.make("environment-a"),
      threadId: ThreadId.make("thread-a"),
    };

    expect(previewRuntimeTabId(base, "epoch-a", durableTabId)).not.toBe(
      previewRuntimeTabId(
        { ...base, environmentId: EnvironmentId.make("environment-b") },
        "epoch-a",
        durableTabId,
      ),
    );
    expect(previewRuntimeTabId(base, "epoch-a", durableTabId)).not.toBe(
      previewRuntimeTabId(
        { ...base, threadId: ThreadId.make("thread-b") },
        "epoch-a",
        durableTabId,
      ),
    );
  });

  it("keeps a persisted UUID tab attached to the same guest across a server restart", () => {
    const ref = {
      environmentId: EnvironmentId.make("environment-a"),
      threadId: ThreadId.make("thread-a"),
    };

    expect(previewRuntimeTabId(ref, "epoch-a", durableTabId)).toBe(
      previewRuntimeTabId(ref, "epoch-b", durableTabId),
    );
  });

  it("is stable for the same runtime tab", () => {
    const ref = {
      environmentId: EnvironmentId.make("environment-a"),
      threadId: ThreadId.make("thread-a"),
    };
    expect(previewRuntimeTabId(ref, null, "tab_1")).toBe(previewRuntimeTabId(ref, null, "tab_1"));
  });

  it("retains the epoch fence for legacy process-local tab ids", () => {
    const ref = {
      environmentId: EnvironmentId.make("environment-a"),
      threadId: ThreadId.make("thread-a"),
    };
    const runtimeTabId = previewRuntimeTabId(ref, "epoch-a", "tab_1");

    expect(isCurrentPreviewRuntimeTab(ref, "epoch-a", "tab_1", runtimeTabId)).toBe(true);
    expect(isCurrentPreviewRuntimeTab(ref, "epoch-b", "tab_1", runtimeTabId)).toBe(false);
  });
});
