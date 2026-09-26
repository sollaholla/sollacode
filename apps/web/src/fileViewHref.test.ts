import { describe, expect, it } from "vite-plus/test";

import { fileViewHref } from "./fileViewHref";

describe("fileViewHref", () => {
  it("builds the viewer URL against the environment's HTTP base", () => {
    expect(
      fileViewHref("https://solomans-macbook-pro.tail0b929e.ts.net/", "/Users/sol/Docs/a b.md"),
    ).toBe("https://solomans-macbook-pro.tail0b929e.ts.net/api/view/Users/sol/Docs/a%20b.md");
  });

  it("returns null without a connection or for a path the viewer cannot serve", () => {
    expect(fileViewHref(null, "/Users/sol/a.md")).toBeNull();
    expect(fileViewHref("http://127.0.0.1:3773", "src/a.md")).toBeNull();
  });
});
