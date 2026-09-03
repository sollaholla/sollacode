import { describe, expect, it } from "vite-plus/test";

import { resolveAgentGlyphKey } from "./agentGlyphKey";

describe("resolveAgentGlyphKey", () => {
  it("picks a themed glyph when the name carries a keyword", () => {
    expect(resolveAgentGlyphKey("Pawstalgia")).toBe("paw");
    expect(resolveAgentGlyphKey("VeeraMedical Engineer")).toBe("heart");
    expect(resolveAgentGlyphKey("Personal Assistant")).toBe("user");
    expect(resolveAgentGlyphKey("Doodle Dungeon")).toBe("pencil");
    expect(resolveAgentGlyphKey("Open World")).toBe("globe");
    expect(resolveAgentGlyphKey("SolomansComputer")).toBe("monitor");
  });

  it("falls back to a stable neutral glyph for other names", () => {
    const first = resolveAgentGlyphKey("Quarterly Numbers");
    expect(resolveAgentGlyphKey("Quarterly Numbers")).toBe(first);
    expect(["bot", "cpu", "rocket", "compass", "flask", "wrench"]).toContain(first);
  });

  it("does not let a bare substring hijack a themed glyph", () => {
    // "Sparta" contains "art" but is not an art agent.
    expect(resolveAgentGlyphKey("Sparta")).not.toBe("pencil");
  });
});
