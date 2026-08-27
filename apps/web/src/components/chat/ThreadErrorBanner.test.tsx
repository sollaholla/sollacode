import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  describeThreadErrorGuidance,
  isHostRepairEligibleThreadError,
  ThreadErrorBanner,
} from "./ThreadErrorBanner";

describe("ThreadErrorBanner", () => {
  it("keeps the portrait dismiss action above overlays with a real touch target", () => {
    const markup = renderToStaticMarkup(
      <ThreadErrorBanner error="Provider failed" onDismiss={vi.fn()} />,
    );

    expect(markup).toContain('data-chat-thread-error-banner="true"');
    expect(markup).toContain("pointer-events-auto");
    expect(markup).toContain("z-30");
    expect(markup).toContain('aria-label="Dismiss error and reset the session"');
    expect(markup).toContain('data-chat-thread-error-dismiss="true"');
    expect(markup).toContain("size-11");
    expect(markup).toContain("touch-manipulation");
    expect(markup).toContain("opacity-100");
    expect(markup).not.toContain(' disabled=""');
  });

  it("offers a guarded repair agent for host-level provider failures", () => {
    const markup = renderToStaticMarkup(
      <ThreadErrorBanner
        error="Codex App Server did not respond to 'thread/resume' within 90000ms."
        onFixWithAi={vi.fn()}
      />,
    );

    expect(markup).toContain('data-chat-thread-error-fix-with-ai="true"');
    expect(markup).toContain('aria-label="Fix computer performance with AI"');
    expect(markup).toContain("Fix with AI");
    expect(markup).toContain("guarded background agent");
  });

  it("keeps the repair action disabled while its thread is starting", () => {
    const markup = renderToStaticMarkup(
      <ThreadErrorBanner error="ENOSPC" onFixWithAi={vi.fn()} fixingWithAi />,
    );

    expect(markup).toContain(' disabled=""');
    expect(markup).toContain("Starting…");
  });

  it("explains a provider protocol mismatch instead of showing only the raw decode error", () => {
    // The regression this exists for: Codex updated itself underneath the app
    // and every resume failed with a message naming no cause and no remedy.
    const markup = renderToStaticMarkup(
      <ThreadErrorBanner error="Invalid payload for method 'thread/resume' during 'decode-payload'" />,
    );

    expect(markup).toContain('data-chat-thread-error-guidance="true"');
    expect(markup).toContain("updated to a protocol this build");
    expect(markup).toContain("Starting a new thread on it still works");
  });

  it("recognises payload drift in either direction and leaves other errors alone", () => {
    expect(
      describeThreadErrorGuidance(
        "Invalid payload for method 'thread/resume' during 'decode-payload'",
      ),
    ).not.toBeNull();
    expect(
      describeThreadErrorGuidance(
        "Invalid payload for method 'turn/start' during 'encode-payload'",
      ),
    ).not.toBeNull();
    expect(describeThreadErrorGuidance("Provider rejected the selected model")).toBeNull();
    expect(describeThreadErrorGuidance(null)).toBeNull();
  });

  it("does not route a protocol mismatch to the host repair agent", () => {
    // Nothing is wrong with the machine, so offering to diagnose it wastes time.
    expect(
      isHostRepairEligibleThreadError(
        "Invalid payload for method 'thread/resume' during 'decode-payload'",
      ),
    ).toBe(false);
  });

  it("limits host repair onboarding to resource and startup failures", () => {
    expect(
      isHostRepairEligibleThreadError(
        "Codex App Server did not respond to 'thread/resume' within 90000ms.",
      ),
    ).toBe(true);
    expect(isHostRepairEligibleThreadError("ENOSPC: no space left on device")).toBe(true);
    expect(isHostRepairEligibleThreadError("Provider rejected the selected model")).toBe(false);
    expect(isHostRepairEligibleThreadError(null)).toBe(false);
  });
});
