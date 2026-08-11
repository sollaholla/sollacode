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

  it("renders nothing when every status is absent", () => {
    expect(renderToStaticMarkup(<ComposerStatusRail />)).toBe("");
  });
});

describe("ProviderTaskChip responsive labels", () => {
  it("keeps full, compact, and minimal labels available to container-query states", () => {
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
    expect(markup).toContain("1 stalled task");
    expect(markup).toContain("1 stalled");
    expect(markup).toContain("chat-composer-status-label-minimal");
    expect(markup).not.toContain("absolute -top-8");
  });
});
