import { describe, expect, it } from "vite-plus/test";

import { fileViewHref } from "./fileViewHref";

describe("fileViewHref", () => {
  it("builds the viewer URL against the environment's HTTP base", () => {
    expect(fileViewHref("https://studio-macbook.example.ts.net/", "/Users/me/Docs/a b.md")).toBe(
      "https://studio-macbook.example.ts.net/api/view/Users/me/Docs/a%20b.md",
    );
  });

  it("returns null without a connection or for a path the viewer cannot serve", () => {
    expect(fileViewHref(null, "/Users/me/a.md")).toBeNull();
    expect(fileViewHref("http://127.0.0.1:3773", "src/a.md")).toBeNull();
  });
});
