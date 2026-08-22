import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import type { ProviderTask } from "../../providerTasks";
import { ProviderTaskChip } from "../ProviderTaskChip";
import { ComposerStatusRail } from "./ComposerStatusRail";

describe("ComposerStatusRail", () => {
  it("renders one coordinated rail with named slots", () => {
    const markup = renderToStaticMarkup(
      <ComposerStatusRail
        voice={<button type="button">Voice</button>}
        usage={<button type="button">Usage</button>}
        actions={<button type="button">Tasks</button>}
      />,
    );

    expect(markup).toContain('data-chat-composer-status-rail="true"');
    expect(markup).toContain('data-chat-composer-status-slot="voice"');
    expect(markup).toContain('data-chat-composer-status-slot="usage"');
    expect(markup).toContain('data-chat-composer-status-slot="actions"');
  });

  // The rail is stacked directly on top of the input bar, so it has to be the
  // same measure. Given its own max-width it was the wider of the two, leaving
  // the end-aligned task chip stranded to the right of the composer.
  it("spans the composer's measure rather than a width of its own", () => {
    const markup = renderToStaticMarkup(<ComposerStatusRail usage={<span>Usage</span>} />);

    expect(markup).toContain("chat-composer-measure");
    expect(markup).not.toMatch(/max-w-\w+/u);
  });

  it("renders nothing when every status is absent", () => {
    expect(renderToStaticMarkup(<ComposerStatusRail />)).toBe("");
  });
});

describe("ProviderTaskChip compact rendering", () => {
  it("renders icon plus count with the full sentence kept accessible", () => {
    const task: ProviderTask = {
      taskId: "task-1",
      taskType: "local_agent",
      title: "Inspect layout",
      summary: null,
      lastToolName: null,
      status: "stale",
      startedAt: "2026-08-11T00:00:00.000Z",
      updatedAt: "2026-08-11T00:00:00.000Z",
      toolUses: null,
    };
    const markup = renderToStaticMarkup(
      <ProviderTaskChip tasks={[task]} onOpen={vi.fn()} positioned={false} />,
    );

    expect(markup).toContain('data-chat-composer-status-chip="provider-tasks"');
    // The sentence lives in the accessible name; the visible chip is only a
    // hammer and the count.
    expect(markup).toContain('aria-label="1 stalled task. Show agents and tasks."');
    expect(markup).toContain("lucide-hammer");
    expect(markup).toContain(">1</span>");
    expect(markup).not.toContain("chat-composer-status-label-full");
    expect(markup).not.toContain("absolute -top-8");
  });
});
