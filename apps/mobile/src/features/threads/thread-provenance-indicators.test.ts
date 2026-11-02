import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { threadProvenanceAccessibilityLabel } from "./thread-provenance";

const environmentId = EnvironmentId.make("env-1");

describe("thread provenance indicators", () => {
  it("names the creating chat, and says nothing for a thread the person started", () => {
    expect(
      threadProvenanceAccessibilityLabel(
        { id: ThreadId.make("plain"), environmentId, createdByThreadId: null },
        null,
      ),
    ).toBeNull();
    expect(
      threadProvenanceAccessibilityLabel(
        {
          id: ThreadId.make("agent-created"),
          environmentId,
          createdByThreadId: ThreadId.make("agent"),
        },
        "Created by Scout",
      ),
    ).toBe("Created by Scout");
  });
});
