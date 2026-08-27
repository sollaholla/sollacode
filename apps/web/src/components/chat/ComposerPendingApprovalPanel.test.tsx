import { ApprovalRequestId } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import { ComposerPendingApprovalActions } from "./ComposerPendingApprovalActions";
import { ComposerPendingApprovalPanel } from "./ComposerPendingApprovalPanel";

describe("ComposerPendingApprovalPanel", () => {
  it("renders complete multiline command details without hover or truncation", () => {
    const detail = `bun run release -- ${"long-argument ".repeat(20)}\nsecond line`;
    const markup = renderToStaticMarkup(
      <ComposerPendingApprovalPanel
        approval={{
          requestId: ApprovalRequestId.make("approval-1"),
          requestKind: "command",
          createdAt: "2026-07-18T00:00:00.000Z",
          detail,
        }}
        pendingCount={1}
      />,
    );

    expect(markup).toContain('data-approval-detail="complete"');
    expect(markup).toContain('aria-label="Command"');
    expect(markup).toContain(detail);
    expect(markup).not.toContain("truncate");
    expect(markup).not.toContain("line-clamp");
  });

  it("scrolls a long command instead of hiding it or pushing the buttons away", () => {
    // Reported twice: a long command could not be read before approving it,
    // and on a phone the approve buttons sat below an unscrollable block.
    const markup = renderToStaticMarkup(
      <ComposerPendingApprovalPanel
        approval={{
          requestId: ApprovalRequestId.make("approval-1"),
          requestKind: "command",
          createdAt: "2026-07-18T00:00:00.000Z",
          detail: Array.from({ length: 60 }, (_, index) => `echo line-${index}`).join("\n"),
        }}
        pendingCount={1}
      />,
    );

    // Bounded height, so the actions below it stay on screen...
    expect(markup).toContain("max-h-40");
    // ...a real scroll viewport rather than a bare overflow...
    expect(markup).toContain('data-slot="scroll-area-viewport"');
    // ...and a finger drag that belongs to this box and stops here.
    expect(markup).toContain("touch-pan-y");
    expect(markup).toContain("overscroll-contain");
  });

  it("keeps every approval action visible in a two-column phone layout", () => {
    const markup = renderToStaticMarkup(
      <ComposerPendingApprovalActions
        requestId={ApprovalRequestId.make("approval-1")}
        isResponding={false}
        onRespondToApproval={vi.fn()}
      />,
    );

    expect(markup).toContain('data-composer-approval-actions="ready"');
    expect(markup).toContain("grid-cols-2");
    expect(markup).toContain("min-w-0");
    expect(markup).toContain("Approve once");
    expect(markup).toContain("Always allow this session");
    expect(markup).toContain("Decline");
    expect(markup).toContain("Cancel turn");
  });

  it("replaces the action grid with a stable resolving state", () => {
    const markup = renderToStaticMarkup(
      <ComposerPendingApprovalActions
        requestId={ApprovalRequestId.make("approval-1")}
        isResponding
        onRespondToApproval={vi.fn()}
      />,
    );

    expect(markup).toContain('data-composer-approval-actions="resolving"');
    expect(markup).toContain("Resolving…");
    expect(markup).not.toContain("Approve once");
  });
});
