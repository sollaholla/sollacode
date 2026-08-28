import { describe, expect, it } from "vite-plus/test";

import { previewBrowserProfileScope, selectLegacyBrowserProfile } from "./browserProfileScope.ts";

describe("previewBrowserProfileScope", () => {
  it("gives every thread in an environment the same profile", () => {
    // The bug this replaces: each thread hashed to its own partition, so an
    // agent read `LOGGED_IN: false` on a site the user was signed into.
    expect(previewBrowserProfileScope("primary")).toBe(previewBrowserProfileScope("primary"));
  });

  it("keeps separate environments on separate profiles", () => {
    expect(previewBrowserProfileScope("primary")).not.toBe(previewBrowserProfileScope("remote-vm"));
  });
});

describe("selectLegacyBrowserProfile", () => {
  it("adopts the jar holding the most cookies, which is where the logins are", () => {
    expect(
      selectLegacyBrowserProfile([
        { directory: "t3code-preview-aaa", cookieBytes: 20_480 },
        { directory: "t3code-preview-bbb", cookieBytes: 618_496 },
        { directory: "t3code-preview-ccc", cookieBytes: 45_056 },
      ]),
    ).toBe("t3code-preview-bbb");
  });

  it("ignores empty jars so the one adoption is not spent on a fresh profile", () => {
    expect(
      selectLegacyBrowserProfile([
        { directory: "t3code-preview-empty", cookieBytes: 0 },
        { directory: "t3code-preview-signed-in", cookieBytes: 1_024 },
      ]),
    ).toBe("t3code-preview-signed-in");
  });

  it("has nothing to adopt when every jar is empty", () => {
    expect(
      selectLegacyBrowserProfile([{ directory: "t3code-preview-empty", cookieBytes: 0 }]),
    ).toBeNull();
  });

  it("has nothing to adopt on a first run", () => {
    expect(selectLegacyBrowserProfile([])).toBeNull();
  });

  it("picks the same jar every run when two are the same size", () => {
    const profiles = [
      { directory: "t3code-preview-bbb", cookieBytes: 4_096 },
      { directory: "t3code-preview-aaa", cookieBytes: 4_096 },
    ];
    expect(selectLegacyBrowserProfile(profiles)).toBe("t3code-preview-aaa");
    expect(selectLegacyBrowserProfile([...profiles].reverse())).toBe("t3code-preview-aaa");
  });
});
