import { AGENTS_PROJECT_ID, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  browserProfileKey,
  parseBrowserProfileKey,
  resolveBrowserProfile,
  resolveHostedBrowserProfileBinding,
  type BrowserProfileThread,
} from "./hostedBrowserProfileBinding";

describe("resolveBrowserProfile", () => {
  const threadId = ThreadId.make("thread-a");
  const owner = ThreadId.make("thread-owner");
  const thread = (overrides: Partial<BrowserProfileThread>): BrowserProfileThread => ({
    threadId,
    projectId: "project-1",
    browserProfileThreadId: undefined,
    profileRootProjectId: undefined,
    ...overrides,
  });

  it("gives a project's threads the project's profile, not their own", () => {
    expect(resolveBrowserProfile(thread({}))).toEqual({ kind: "project", projectId: "project-1" });
  });

  it("keeps a side chat in its project's profile", () => {
    expect(
      resolveBrowserProfile(
        thread({ browserProfileThreadId: owner, profileRootProjectId: "project-1" }),
      ),
    ).toEqual({ kind: "project", projectId: "project-1" });
  });

  it("gives an agent's chat its own profile", () => {
    expect(resolveBrowserProfile(thread({ projectId: AGENTS_PROJECT_ID }))).toEqual({
      kind: "agent",
      rootThreadId: threadId,
    });
  });

  it("keeps a thread an agent opened elsewhere in that agent's profile", () => {
    expect(
      resolveBrowserProfile(
        thread({ browserProfileThreadId: owner, profileRootProjectId: AGENTS_PROJECT_ID }),
      ),
    ).toEqual({ kind: "agent", rootThreadId: owner });
  });

  it("falls back to the thread's own project when its owner is gone", () => {
    expect(resolveBrowserProfile(thread({ browserProfileThreadId: owner }))).toEqual({
      kind: "project",
      projectId: "project-1",
    });
  });

  it("round-trips through its atom key", () => {
    for (const profile of [
      { kind: "project", projectId: "project:with:colons" },
      { kind: "agent", rootThreadId: owner },
    ] as const) {
      expect(parseBrowserProfileKey(browserProfileKey(profile))).toEqual(profile);
    }
    expect(parseBrowserProfileKey("")).toBeUndefined();
  });
});

describe("resolveHostedBrowserProfileBinding", () => {
  const shell: BrowserProfileThread = {
    threadId: ThreadId.make("thread-a"),
    projectId: "project-1",
    browserProfileThreadId: undefined,
    profileRootProjectId: undefined,
  };

  it("withholds a new guest until its thread shell is known", () => {
    expect(resolveHostedBrowserProfileBinding(null, undefined)).toBeNull();
  });

  it("binds a new guest once its shell arrives", () => {
    expect(resolveHostedBrowserProfileBinding(null, shell)).toEqual({
      profile: { kind: "project", projectId: "project-1" },
    });
  });

  it("keeps a bound guest's profile through a shell gap or a change", () => {
    const bound = resolveHostedBrowserProfileBinding(null, shell);
    expect(resolveHostedBrowserProfileBinding(bound, undefined)).toBe(bound);
    expect(resolveHostedBrowserProfileBinding(bound, { ...shell, projectId: "other" })).toBe(bound);
  });
});
