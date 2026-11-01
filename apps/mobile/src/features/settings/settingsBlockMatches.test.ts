import { describe, expect, it } from "vite-plus/test";

import { settingsBlockMatches } from "./settingsBlockMatches";

describe("settingsBlockMatches", () => {
  const block = { terms: ["automatic storage cleanup", "disk", "cache"] };

  it("shows everything for an empty search", () => {
    expect(settingsBlockMatches(block, "  ")).toBe(true);
  });

  it("needs every word to hit, in any case and order", () => {
    expect(settingsBlockMatches(block, "CACHE disk")).toBe(true);
    expect(settingsBlockMatches(block, "disk theme")).toBe(false);
  });
});
