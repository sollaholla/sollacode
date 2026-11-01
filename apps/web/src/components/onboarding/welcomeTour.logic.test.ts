import { describe, expect, it } from "vite-plus/test";

import { parseWelcomeProgress, searchShortcutLabel, WELCOME_TOUR_STEPS } from "./welcomeTour.logic";

const wordCount = (text: string) => text.trim().split(/\s+/).length;

describe("welcome tour copy", () => {
  it("keeps every step short enough to read at a glance", () => {
    for (const step of WELCOME_TOUR_STEPS) {
      expect(wordCount(step.title), step.id).toBeLessThanOrEqual(5);
      expect(wordCount(step.body), step.id).toBeLessThanOrEqual(18);
      if ("touchBody" in step) {
        expect(wordCount(step.touchBody), step.id).toBeLessThanOrEqual(18);
      }
    }
  });

  it("explains the words someone has never met instead of assuming them", () => {
    const copy = WELCOME_TOUR_STEPS.map((step) => `${step.title} ${step.body}`)
      .join(" ")
      .toLowerCase();
    for (const jargon of ["provider", "harness", "worktree", "orchestrat", "repo", "model"]) {
      expect(copy).not.toContain(jargon);
    }
  });
});

describe("searchShortcutLabel", () => {
  it("spells the shortcut the way this computer does", () => {
    expect(searchShortcutLabel("MacIntel")).toBe("⌘K");
    expect(searchShortcutLabel("iPad")).toBe("⌘K");
    expect(searchShortcutLabel("Win32")).toBe("Ctrl K");
    expect(searchShortcutLabel("Linux x86_64")).toBe("Ctrl K");
  });
});

describe("parseWelcomeProgress", () => {
  it("resumes at the saved tour step", () => {
    expect(parseWelcomeProgress("tour:0")).toEqual({ screen: "tour", step: 0 });
    expect(parseWelcomeProgress("tour:5")).toEqual({ screen: "tour", step: 5 });
  });

  it("starts from preferences when there is nothing usable saved", () => {
    expect(parseWelcomeProgress(null)).toEqual({ screen: "preferences" });
    expect(parseWelcomeProgress("preferences")).toEqual({ screen: "preferences" });
    expect(parseWelcomeProgress("tour:")).toEqual({ screen: "preferences" });
    expect(parseWelcomeProgress("tour:-1")).toEqual({ screen: "preferences" });
    expect(parseWelcomeProgress("garbage")).toEqual({ screen: "preferences" });
  });

  it("does not resume past the end after the tour gets shorter", () => {
    expect(parseWelcomeProgress(`tour:${WELCOME_TOUR_STEPS.length}`)).toEqual({
      screen: "preferences",
    });
  });
});
