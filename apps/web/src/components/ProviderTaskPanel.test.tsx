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
  it("shows actual provider tokens and reports missing totals as unknown", () => {
    const markup = renderToStaticMarkup(
      <ProviderTaskPanel
        tasks={[
          {
            ...task,
            taskId: "codex-subagent:child",
            title: "Codex subagent image preview",
            totalTokens: 1234,
          },
          { ...task, taskId: "unknown-tokens", totalTokens: null },
        ]}
      />,
    );
    expect(markup).toContain("1,234 tokens");
    expect(markup).toContain("tokens unknown");
    expect(markup).toContain('data-provider-task-placement="composer"');
  });

  it("shows commands and monitors without agent usage fields", () => {
    const markup = renderToStaticMarkup(
      <ProviderTaskPanel
        tasks={[
          {
            ...task,
            taskId: "command",
            taskType: "local_bash",
            title: "Build the island",
            totalTokens: 1234,
          },
          {
            ...task,
            taskId: "monitor",
            taskType: "local_monitor",
            title: "Watch the log",
            totalTokens: null,
          },
        ]}
      />,
    );
    expect(markup).toContain("Background command · Running");
    expect(markup).toContain("Monitor · Watching");
    expect(markup).toContain("Background tasks · 2 active");
    expect(markup).not.toContain("tokens");
    expect(markup).not.toContain("tool uses");
    expect(markup).not.toContain("Sub-agent");
  });

  it("does not invent token usage for tasks without an agent type", () => {
    const markup = renderToStaticMarkup(
      <ProviderTaskPanel tasks={[{ ...task, taskType: null, toolUses: null }]} />,
    );
    expect(markup).not.toContain("tokens unknown");
  });

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

  it("offers Stop but never Dismiss for a running task", () => {
    const markup = renderToStaticMarkup(
      <ProviderTaskPanel tasks={[task]} onStopTask={() => undefined} />,
    );
    expect(markup).toContain(`aria-label="Stop ${task.title}"`);
    // Dismissing live work hid the row while the task still held the turn, so
    // the panel read as empty and the user's messages stayed queued behind it.
    expect(markup).not.toContain(`aria-label="Dismiss ${task.title}"`);
  });

  it("withholds Dismiss from a running task even when no Stop channel is wired", () => {
    const markup = renderToStaticMarkup(<ProviderTaskPanel tasks={[task]} />);

    expect(markup).not.toContain(`aria-label="Stop ${task.title}"`);
    expect(markup).not.toContain(`aria-label="Dismiss ${task.title}"`);
  });

  it("offers Dismiss once a task has gone stale", () => {
    // A dead runtime is still reachable: silence past PROVIDER_TASK_STALE_AFTER_MS
    // downgrades the task to `stale`, which is what makes the row hideable again.
    const markup = renderToStaticMarkup(
      <ProviderTaskPanel tasks={[{ ...task, status: "stale" }]} onStopTask={() => undefined} />,
    );

    expect(markup).toContain(`aria-label="Dismiss ${task.title}"`);
    expect(markup).not.toContain(`aria-label="Stop ${task.title}"`);
  });

  it("gives Clear a hit area as tall as the header", () => {
    const markup = renderToStaticMarkup(
      <ProviderTaskPanel tasks={[{ ...task, status: "completed" }]} />,
    );
    const clear = markup.match(/<button[^>]*>Clear<\/button>/)?.[0] ?? "";

    // A near miss on the small label landed on the collapse toggle underneath
    // and folded the panel instead of clearing it.
    expect(clear).toContain("before:absolute");
    expect(clear).toContain("before:-inset-y-2");
  });

  it("starts collapsed when it is bound to a thread", () => {
    const markup = renderToStaticMarkup(
      <ProviderTaskPanel tasks={[task]} threadKey="environment:thread" />,
    );

    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain("Background tasks · 1 active");
    expect(markup).not.toContain(task.title);
  });
});
