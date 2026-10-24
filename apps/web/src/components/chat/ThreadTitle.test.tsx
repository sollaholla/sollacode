// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { isThreadTitleTruncated, ThreadTitle } from "./ThreadTitle";

describe("isThreadTitleTruncated", () => {
  it("is true only when the text is wider than its box", () => {
    expect(isThreadTitleTruncated({ scrollWidth: 320, clientWidth: 120 })).toBe(true);
    expect(isThreadTitleTruncated({ scrollWidth: 120, clientWidth: 120 })).toBe(false);
    expect(isThreadTitleTruncated(null)).toBe(false);
  });
});

describe("ThreadTitle", () => {
  beforeEach(() => vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true));
  afterEach(() => vi.unstubAllGlobals());

  async function mountWithWidths(title: string, widths: { scroll: number; client: number }) {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => root.render(<ThreadTitle title={title} />));
    const trigger = container.querySelector<HTMLButtonElement>("[data-slot=popover-trigger]")!;
    Object.defineProperty(trigger, "scrollWidth", { configurable: true, value: widths.scroll });
    Object.defineProperty(trigger, "clientWidth", { configurable: true, value: widths.client });
    return {
      trigger,
      cleanup: async () => {
        await act(async () => root.unmount());
        container.remove();
      },
    };
  }
  const fullTitleShown = (title: string) =>
    [...document.querySelectorAll("[data-slot=popover-popup]")].some((node) =>
      node.textContent?.includes(title),
    );

  it("keeps the accessible name on the heading and one line in the header", async () => {
    const { trigger, cleanup } = await mountWithWidths("Fix missing Sonnet 5.5", {
      scroll: 100,
      client: 100,
    });
    try {
      expect(trigger.closest("h2")?.getAttribute("aria-label")).toBe("Fix missing Sonnet 5.5");
      expect(trigger.className).toContain("truncate");
    } finally {
      await cleanup();
    }
  });

  it("keeps a tappable minimum width, so a long project name cannot squeeze it out", async () => {
    // The project crumb used to be shrink-0 and left the title a few pixels
    // wide on a phone. A zero floor here would bring that back.
    const { trigger, cleanup } = await mountWithWidths("Fix missing Sonnet 5.5", {
      scroll: 100,
      client: 100,
    });
    try {
      const heading = trigger.closest("h2");
      expect(heading?.className).toContain("min-w-20");
      expect(heading?.className).not.toContain("min-w-0");
    } finally {
      await cleanup();
    }
  });

  it("shows the full name when a clipped title is tapped", async () => {
    const title = "Fix missing Sonnet 5.5 in the Claude model list and clear disk space";
    const { trigger, cleanup } = await mountWithWidths(title, { scroll: 480, client: 90 });
    try {
      expect(fullTitleShown(title)).toBe(false);
      await act(async () => trigger.click());
      expect(fullTitleShown(title)).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it("does not open for a title that already fits", async () => {
    const title = "Short";
    const { trigger, cleanup } = await mountWithWidths(title, { scroll: 40, client: 40 });
    try {
      await act(async () => trigger.click());
      expect(fullTitleShown(title)).toBe(false);
    } finally {
      await cleanup();
    }
  });
});
