import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { threadProvenanceAccessibilityLabel } from "./thread-provenance";

describe("thread provenance indicators", () => {
  it("describes agent-created and inherited-browser provenance independently", () => {
    expect(
      threadProvenanceAccessibilityLabel({
        id: ThreadId.make("shared-browser-only"),
        createdByThreadId: null,
        browserProfileThreadId: ThreadId.make("browser-root"),
      }),
    ).toBe("Uses a shared agent browser profile");
    expect(
      threadProvenanceAccessibilityLabel({
        id: ThreadId.make("plain"),
        createdByThreadId: null,
        browserProfileThreadId: null,
      }),
    ).toBeNull();
    expect(
      threadProvenanceAccessibilityLabel({
        id: ThreadId.make("agent-created"),
        createdByThreadId: ThreadId.make("agent"),
        browserProfileThreadId: null,
      }),
    ).toBe("Created by an agent");
    expect(
      threadProvenanceAccessibilityLabel({
        id: ThreadId.make("shared"),
        createdByThreadId: ThreadId.make("agent"),
        browserProfileThreadId: ThreadId.make("browser-root"),
      }),
    ).toBe("Created by an agent, Uses a shared agent browser profile");
  });
});
