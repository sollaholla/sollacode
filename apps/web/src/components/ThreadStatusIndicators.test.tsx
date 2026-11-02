import { EnvironmentId, ORCHESTRATOR_THREAD_ID, ThreadId } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { ThreadProvenanceIndicators, ThreadWorktreeIndicator } from "./ThreadStatusIndicators";

describe("ThreadWorktreeIndicator", () => {
  it("renders the worktree folder and branch in an accessible label", () => {
    const markup = renderToStaticMarkup(
      <ThreadWorktreeIndicator
        thread={{
          id: ThreadId.make("thread-1"),
          branch: "feature/sidebar-indicator",
          worktreePath: "/tmp/worktrees/sidebar-indicator",
        }}
      />,
    );

    expect(markup).toContain('role="img"');
    expect(markup).toContain(
      'aria-label="Worktree: sidebar-indicator (feature/sidebar-indicator)"',
    );
    expect(markup).toContain('data-testid="thread-worktree-thread-1"');
  });

  it.each([null, "", "   "])("renders nothing for an absent worktree path", (worktreePath) => {
    const markup = renderToStaticMarkup(
      <ThreadWorktreeIndicator
        thread={{
          id: ThreadId.make("thread-1"),
          branch: "main",
          worktreePath,
        }}
      />,
    );

    expect(markup).toBe("");
  });
});

describe("ThreadProvenanceIndicators", () => {
  const environmentId = EnvironmentId.make("env-provenance");

  it("names the creator instead of assuming an agent", () => {
    const fromOrchestrator = renderToStaticMarkup(
      <ThreadProvenanceIndicators
        thread={{
          id: ThreadId.make("thread-1"),
          environmentId,
          createdByThreadId: ORCHESTRATOR_THREAD_ID,
          browserProfileThreadId: null,
        }}
      />,
    );
    expect(fromOrchestrator).toContain('aria-label="Created by the Orchestrator"');

    const fromUnknownChat = renderToStaticMarkup(
      <ThreadProvenanceIndicators
        thread={{
          id: ThreadId.make("thread-2"),
          environmentId,
          createdByThreadId: ThreadId.make("chat-not-loaded"),
          browserProfileThreadId: ThreadId.make("chat-not-loaded"),
        }}
      />,
    );
    expect(fromUnknownChat).toContain('aria-label="Created by another chat"');
    expect(fromUnknownChat).not.toContain("shared browser");
  });

  it("renders nothing for a thread the person started", () => {
    expect(
      renderToStaticMarkup(
        <ThreadProvenanceIndicators
          thread={{
            id: ThreadId.make("thread-3"),
            environmentId,
            createdByThreadId: null,
            browserProfileThreadId: null,
          }}
        />,
      ),
    ).toBe("");
  });
});
