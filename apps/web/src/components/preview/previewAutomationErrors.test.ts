import { EnvironmentId, PreviewTabId, ThreadId, TrimmedNonEmptyString } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  PreviewAutomationOperationError,
  serializePreviewAutomationHostError,
} from "./previewAutomationErrors";

const context = {
  requestId: TrimmedNonEmptyString.make("preview-26"),
  operation: "type" as const,
  environmentId: EnvironmentId.make("environment-1"),
  threadId: ThreadId.make("thread-1"),
  tabId: PreviewTabId.make("tab_1"),
};

describe("PreviewAutomationOperationError.fromCause", () => {
  it("carries the desktop's reason code so the agent learns which step gave out", () => {
    const error = PreviewAutomationOperationError.fromCause({
      ...context,
      cause: {
        _tag: "PreviewOperationError",
        operation: "automationType.textDidNotReachGuest",
        tabId: "tab_1",
      },
    });

    expect(error.message).toContain("automationType.textDidNotReachGuest");
    expect(serializePreviewAutomationHostError(error).message).toContain(
      "automationType.textDidNotReachGuest",
    );
  });

  it("reads as before when the cause carries no reason code", () => {
    const error = PreviewAutomationOperationError.fromCause({
      ...context,
      cause: new Error("boom"),
    });

    expect(error.message).toContain("failed on environment environment-1");
    expect(error.message).not.toContain("[");
  });

  it("ignores a reason that is not a usable identifier", () => {
    for (const operation of ["", "   ", "x".repeat(129), 42]) {
      const error = PreviewAutomationOperationError.fromCause({
        ...context,
        cause: { _tag: "PreviewOperationError", operation },
      });
      expect(error.message).not.toContain("[");
    }
  });
});
