import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveHostedBrowserProfileBinding } from "./hostedBrowserProfileBinding";

describe("resolveHostedBrowserProfileBinding", () => {
  const threadId = ThreadId.make("thread-a");
  const inheritedProfileThreadId = ThreadId.make("thread-owner");

  it("withholds a new guest until its thread shell is known", () => {
    expect(resolveHostedBrowserProfileBinding(null, undefined)).toBeNull();
  });

  it("binds an ordinary thread to its own persistent profile", () => {
    expect(
      resolveHostedBrowserProfileBinding(null, {
        threadId,
        browserProfileThreadId: undefined,
      }),
    ).toEqual({ profileThreadId: threadId });
  });

  it("binds an agent-created thread to its inherited browser profile", () => {
    expect(
      resolveHostedBrowserProfileBinding(null, {
        threadId,
        browserProfileThreadId: inheritedProfileThreadId,
      }),
    ).toEqual({ profileThreadId: inheritedProfileThreadId });
  });

  it("keeps the first binding through shell loss or later metadata churn", () => {
    const binding = { profileThreadId: inheritedProfileThreadId };

    expect(resolveHostedBrowserProfileBinding(binding, undefined)).toBe(binding);
    expect(
      resolveHostedBrowserProfileBinding(binding, {
        threadId,
        browserProfileThreadId: ThreadId.make("different-owner"),
      }),
    ).toBe(binding);
  });
});
