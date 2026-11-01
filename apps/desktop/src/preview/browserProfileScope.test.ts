import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { previewBrowserProfileScope } from "./browserProfileScope.ts";
import { profileDirectoryForScope } from "./browserProfiles.ts";

const agent = (id: string) => ({ kind: "agent", rootThreadId: ThreadId.make(id) }) as const;
const project = (projectId: string) => ({ kind: "project", projectId }) as const;

describe("previewBrowserProfileScope", () => {
  it("gives every thread in a project the same scope, and different projects different ones", () => {
    expect(previewBrowserProfileScope("env-1", project("p1"))).toBe("env-1:project:p1");
    expect(previewBrowserProfileScope("env-1", project("p1"))).not.toBe(
      previewBrowserProfileScope("env-1", project("p2")),
    );
  });

  it("keeps an agent's scope on its old thread key, so its folder and logins stay put", () => {
    expect(previewBrowserProfileScope("env-1", agent("agent-thread"))).toBe(
      "env-1:thread:agent-thread",
    );
    expect(profileDirectoryForScope("env-1:thread:agent-thread")).toMatch(
      /^t3code-preview-[a-f0-9]{20}$/,
    );
  });

  it("uses the environment's own jar when there is no thread", () => {
    expect(previewBrowserProfileScope("env-1")).toBe("env-1");
    expect(previewBrowserProfileScope("env-1", null)).toBe("env-1");
  });

  it("rejects a missing environment rather than opening a phantom jar", () => {
    expect(() => previewBrowserProfileScope("", project("p1"))).toThrow(/environment id/);
    expect(() => previewBrowserProfileScope("   ")).toThrow(/environment id/);
  });
});
