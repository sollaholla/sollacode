import { describe, expect, it } from "vite-plus/test";
import {
  buildSettingsUpdatePrompt,
  isSettingsUpdatePrompt,
  parseSettingsUpdatePrompt,
} from "./settingsPrompt.ts";

describe("settingsPrompt", () => {
  it("round-trips the description through build and parse", () => {
    const prompt = buildSettingsUpdatePrompt("claude-opus-5 with high effort");
    expect(isSettingsUpdatePrompt(prompt)).toBe(true);
    expect(parseSettingsUpdatePrompt(prompt)).toEqual({
      description: "claude-opus-5 with high effort",
    });
  });

  it("parses persisted legacy turns with drifted instruction wording", () => {
    const prompt =
      "Settings updated: gpt-5.6-sol with max effort. Apply these settings immediately and continue the current task without waiting for another message.";
    expect(parseSettingsUpdatePrompt(prompt)).toEqual({
      description: "gpt-5.6-sol with max effort",
    });
  });

  it("keeps the full remainder when no instruction sentence is present", () => {
    expect(parseSettingsUpdatePrompt("Settings updated: fast mode off")).toEqual({
      description: "fast mode off",
    });
  });

  it("rejects ordinary user text", () => {
    expect(parseSettingsUpdatePrompt("please update my settings")).toBeNull();
    expect(isSettingsUpdatePrompt("please update my settings")).toBe(false);
  });
});
