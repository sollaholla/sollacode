import { describe, expect, it } from "vite-plus/test";

import {
  environmentScopeOf,
  isThreadScopedProfile,
  previewBrowserProfileScope,
  selectLegacyBrowserProfile,
} from "./browserProfileScope.ts";

describe("previewBrowserProfileScope", () => {
  it("returns the bare environment when no profile owner is designated", () => {
    // The user's own conversations share one environment-wide jar so signing in
    // once keeps every user tab in the environment signed in.
    expect(previewBrowserProfileScope("env-1")).toBe("env-1");
    expect(previewBrowserProfileScope("env-1", undefined)).toBe("env-1");
    expect(previewBrowserProfileScope("env-1", null)).toBe("env-1");
    expect(previewBrowserProfileScope("env-1", "   ")).toBe("env-1");
  });

  it("scopes a designated profile owner to its own partition", () => {
    // An agent-created thread (or an inheriting descendant carrying the same
    // browserProfileThreadId) gets its own jar, isolated from the user's.
    expect(previewBrowserProfileScope("env-1", "thread-9")).toBe("env-1:thread:thread-9");
    // Descendants that share one owner id share one partition.
    expect(previewBrowserProfileScope("env-1", "owner-a")).toBe(
      previewBrowserProfileScope("env-1", "owner-a"),
    );
    // Different owners never collide.
    expect(previewBrowserProfileScope("env-1", "owner-a")).not.toBe(
      previewBrowserProfileScope("env-1", "owner-b"),
    );
    // The same owner in a different environment is a different machine's jar.
    expect(previewBrowserProfileScope("env-1", "owner-a")).not.toBe(
      previewBrowserProfileScope("env-2", "owner-a"),
    );
  });

  it("still fails closed on a missing environment id", () => {
    expect(() => previewBrowserProfileScope("")).toThrow(/environment id/);
    expect(() => previewBrowserProfileScope("   ", "thread-9")).toThrow(/environment id/);
    // @ts-expect-error deliberately wrong type to prove the guard.
    expect(() => previewBrowserProfileScope(undefined)).toThrow(/environment id/);
  });
});

describe("environmentScopeOf / isThreadScopedProfile", () => {
  it("recovers the environment a per-thread profile is cloned from", () => {
    const scope = previewBrowserProfileScope("env-1", "thread-9");
    expect(isThreadScopedProfile(scope)).toBe(true);
    expect(environmentScopeOf(scope)).toBe("env-1");
  });

  it("treats a bare environment scope as not thread-scoped and its own source", () => {
    expect(isThreadScopedProfile("env-1")).toBe(false);
    expect(environmentScopeOf("env-1")).toBe("env-1");
  });

  it("round-trips: the source of a per-thread scope is the bare environment scope", () => {
    const environment = "env-42";
    const scope = previewBrowserProfileScope(environment, "agent-thread");
    expect(environmentScopeOf(scope)).toBe(previewBrowserProfileScope(environment));
  });
});

describe("selectLegacyBrowserProfile", () => {
  it("adopts the jar with the most cookies and ignores empty ones", () => {
    expect(
      selectLegacyBrowserProfile([
        { directory: "a", cookieBytes: 0 },
        { directory: "b", cookieBytes: 4096 },
        { directory: "c", cookieBytes: 2048 },
      ]),
    ).toBe("b");
    expect(selectLegacyBrowserProfile([{ directory: "a", cookieBytes: 0 }])).toBeNull();
    expect(selectLegacyBrowserProfile([])).toBeNull();
  });
});
