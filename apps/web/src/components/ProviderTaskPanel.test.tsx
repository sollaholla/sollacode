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
  it("renders every task in a bounded composer drawer instead of paginating", () => {
    const tasks = Array.from({ length: 12 }, (_, index) => ({
      ...task,
      taskId: `composer-task-${index + 1}`,
      title: `Background task ${index + 1}`,
    }));

    const markup = renderToStaticMarkup(<ProviderTaskPanel tasks={tasks} />);

    expect(markup).toContain('aria-label="Background tasks"');
    expect(markup).toContain('data-provider-task-placement="composer"');
    expect(markup).toContain("flex-col-reverse");
    expect(markup).toContain("max-h-[min(38dvh,22rem)]");
    expect(markup).toContain("overflow-y-auto");
    expect(markup).toContain("Background task 12");
    expect(markup).not.toContain('aria-label="Task pages"');
  });

  it("starts collapsed when it is bound to a thread", () => {
    const markup = renderToStaticMarkup(
      <ProviderTaskPanel tasks={[task]} threadKey="environment:thread" />,
    );

    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain("Background tasks · 1 running");
    expect(markup).not.toContain(task.title);
  });
});
