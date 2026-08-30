import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { ThreadSyncOverlay, ThreadSyncStatusPill } from "./ThreadSyncStatusPill";

describe("ThreadSyncStatusPill", () => {
  it.each([
    ["loading", "Loading messages..."],
    ["syncing", "Syncing messages..."],
  ] as const)("renders the %s message sync phase", (phase, label) => {
    const markup = renderToStaticMarkup(<ThreadSyncStatusPill phase={phase} />);

    expect(markup).toContain('role="status"');
    expect(markup).toContain(label);
    expect(markup).toContain("animate-spin");
  });

  it.each([
    ["loading", "Loading conversation…", "Restoring this thread’s messages"],
    ["syncing", "Catching up…", "Fast-forwarding to the latest messages"],
  ] as const)("covers the transcript during %s", (phase, title, detail) => {
    const markup = renderToStaticMarkup(<ThreadSyncOverlay phase={phase} />);

    expect(markup).toContain(`data-thread-sync-overlay="${phase}"`);
    expect(markup).toContain('aria-busy="true"');
    expect(markup).toContain('aria-live="polite"');
    expect(markup).toContain("animate-spin");
    expect(markup).toContain(title);
    expect(markup).toContain(detail);
  });

  it.each([["loading"], ["syncing"]] as const)(
    "lets pointer input through during %s: syncing is a status, not a modal",
    (phase) => {
      const markup = renderToStaticMarkup(<ThreadSyncOverlay phase={phase} />);

      expect(markup).toContain("pointer-events-none");
      // A near-opaque veil is as blocking as a captured tap: what is under it
      // must stay legible enough to act on.
      expect(markup).not.toContain("bg-background/94");
    },
  );
});
