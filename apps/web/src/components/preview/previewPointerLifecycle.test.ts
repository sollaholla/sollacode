import { describe, expect, it } from "vite-plus/test";

import { shouldClearBrowserPointer } from "./previewPointerLifecycle";

const success = (url: string) => ({ kind: "Success", url, title: "Example" }) as const;
const loading = (url: string) => ({ kind: "Loading", url, title: "Example" }) as const;

describe("shouldClearBrowserPointer", () => {
  it("keeps the cursor through a same-URL loading flicker after a click", () => {
    expect(
      shouldClearBrowserPointer(success("https://example.test/"), loading("https://example.test/")),
    ).toBe(false);
    expect(
      shouldClearBrowserPointer(loading("https://example.test/"), success("https://example.test/")),
    ).toBe(false);
  });

  it("clears only when the document actually changes or the tab goes idle", () => {
    expect(
      shouldClearBrowserPointer(
        success("https://example.test/a"),
        loading("https://example.test/b"),
      ),
    ).toBe(true);
    expect(shouldClearBrowserPointer(success("https://example.test/"), { kind: "Idle" })).toBe(
      true,
    );
    expect(shouldClearBrowserPointer(null, loading("https://example.test/"))).toBe(false);
  });
});
