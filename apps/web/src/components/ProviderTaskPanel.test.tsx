import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import type { ProviderTask } from "../providerTasks";
import { ProviderTaskPanel } from "./ProviderTaskPanel";

const task: ProviderTask = {
  taskId: "mobile-layout-task",
  taskType: "local_agent",
  title: "Inspect the mobile layout",
  summary: "Checking the full-width task list.",
  lastToolName: null,
  status: "running",
  startedAt: "2026-08-03T12:00:00.000Z",
  updatedAt: "2026-08-03T12:00:01.000Z",
  toolUses: 2,
};

describe("ProviderTaskPanel", () => {
  it("stacks vertically inside its parent panel instead of becoming a horizontal overlay", () => {
    const markup = renderToStaticMarkup(<ProviderTaskPanel tasks={[task]} highlighted={false} />);

    expect(markup).toContain('aria-label="Agents and tasks"');
    expect(markup).toContain("flex-col");
    expect(markup).toContain("max-h-[45%]");
    expect(markup).toContain("cursor-pointer");
    expect(markup).toContain("hover:bg-accent");
    expect(markup).not.toContain("fixed inset-0");
    expect(markup).not.toContain('role="dialog"');
  });
});
