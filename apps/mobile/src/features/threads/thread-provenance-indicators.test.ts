import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { threadProvenanceAccessibilityLabel } from "./thread-provenance";

const environmentId = EnvironmentId.make("env-1");

describe("thread provenance indicators", () => {
  it("describes the creating chat and inherited-browser provenance independently", () => {
    expect(
      threadProvenanceAccessibilityLabel(
        {
          id: ThreadId.make("shared-browser-only"),
          environmentId,
          createdByThreadId: null,
          browserProfileThreadId: ThreadId.make("browser-root"),
        },
        null,
      ),
    ).toBe("Uses a shared browser profile");
    expect(
      threadProvenanceAccessibilityLabel(
        {
          id: ThreadId.make("plain"),
          environmentId,
          createdByThreadId: null,
          browserProfileThreadId: null,
        },
        null,
      ),
    ).toBeNull();
    expect(
      threadProvenanceAccessibilityLabel(
        {
          id: ThreadId.make("agent-created"),
          environmentId,
          createdByThreadId: ThreadId.make("agent"),
          browserProfileThreadId: null,
        },
        "Created by Scout",
      ),
    ).toBe("Created by Scout");
    expect(
      threadProvenanceAccessibilityLabel(
        {
          id: ThreadId.make("shared"),
          environmentId,
          createdByThreadId: ThreadId.make("chat"),
          browserProfileThreadId: ThreadId.make("browser-root"),
        },
        "Created by “Fix the login bug”",
      ),
    ).toBe("Created by “Fix the login bug”, Uses a shared browser profile");
  });
});
