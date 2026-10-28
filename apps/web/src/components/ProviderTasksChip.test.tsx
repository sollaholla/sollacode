import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import type { ProviderTask } from "../providerTasks";
import { ProviderTaskDetails, ProviderTasksChip } from "./ProviderTasksChip";

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

describe("ProviderTaskDetails", () => {
  it("shows actual provider tokens and reports missing totals as unknown", () => {
    const markup = renderToStaticMarkup(
      <ProviderTaskDetails
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
  });

  it("shows commands and monitors without agent usage fields", () => {
    const markup = renderToStaticMarkup(
      <ProviderTaskDetails
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
    expect(markup).toContain("2 active");
    expect(markup).not.toContain("tokens");
    expect(markup).not.toContain("tool uses");
    expect(markup).not.toContain("Sub-agent");
  });

  it("does not invent token usage for tasks without an agent type", () => {
    const markup = renderToStaticMarkup(
      <ProviderTaskDetails tasks={[{ ...task, taskType: null, toolUses: null }]} />,
    );
    expect(markup).not.toContain("tokens unknown");
  });

  it("lists every task in one scrolling list instead of paginating", () => {
    const tasks = Array.from({ length: 12 }, (_, index) => ({
      ...task,
      taskId: `composer-task-${index + 1}`,
      title: `Background task ${index + 1}`,
    }));

    const markup = renderToStaticMarkup(<ProviderTaskDetails tasks={tasks} />);

    expect(markup).toContain('aria-label="Background tasks"');
    expect(markup).toContain("overflow-y-auto");
    expect(markup).toContain("Background task 12");
    expect(markup).not.toContain('aria-label="Task pages"');
  });

  it("offers Stop but never Dismiss for a running task", () => {
    const markup = renderToStaticMarkup(
      <ProviderTaskDetails tasks={[task]} onStopTask={() => undefined} />,
    );
    expect(markup).toContain(`aria-label="Stop ${task.title}"`);
    // Dismissing live work hid the row while the task still held the turn, so
    // the panel read as empty and the user's messages stayed queued behind it.
    expect(markup).not.toContain(`aria-label="Dismiss ${task.title}"`);
  });

  it("withholds Dismiss from a running task even when no Stop channel is wired", () => {
    const markup = renderToStaticMarkup(<ProviderTaskDetails tasks={[task]} />);

    expect(markup).not.toContain(`aria-label="Stop ${task.title}"`);
    expect(markup).not.toContain(`aria-label="Dismiss ${task.title}"`);
  });

  it("offers Dismiss once a task has gone stale", () => {
    // A dead runtime is still reachable: silence past PROVIDER_TASK_STALE_AFTER_MS
    // downgrades the task to `stale`, which is what makes the row hideable again.
    const markup = renderToStaticMarkup(
      <ProviderTaskDetails tasks={[{ ...task, status: "stale" }]} onStopTask={() => undefined} />,
    );

    expect(markup).toContain(`aria-label="Dismiss ${task.title}"`);
    expect(markup).not.toContain(`aria-label="Stop ${task.title}"`);
  });

  it("offers Clear only when a row can be dismissed", () => {
    expect(renderToStaticMarkup(<ProviderTaskDetails tasks={[task]} />)).not.toContain(">Clear<");
    expect(
      renderToStaticMarkup(<ProviderTaskDetails tasks={[{ ...task, status: "completed" }]} />),
    ).toContain(">Clear<");
  });
});

describe("ProviderTasksChip", () => {
  it("is a rail chip counting running tasks, with the list kept in its popup", () => {
    const markup = renderToStaticMarkup(
      <ProviderTasksChip tasks={[task, { ...task, taskId: "done", status: "completed" }]} />,
    );

    expect(markup).toContain('data-chat-composer-status-chip="background-tasks"');
    expect(markup).toContain('aria-label="1 background task active. Show background tasks."');
    expect(markup).toContain("text-gold-600");
    // The rows live in the popup, which stays closed until the chip is tapped.
    expect(markup).not.toContain(task.title);
  });

  it("goes quiet and counts what still needs a look once nothing runs", () => {
    const markup = renderToStaticMarkup(
      <ProviderTasksChip
        tasks={[
          { ...task, status: "completed" },
          { ...task, taskId: "failed", status: "failed" },
        ]}
      />,
    );

    expect(markup).toContain('aria-label="2 background tasks need a look. Show background tasks."');
    expect(markup).toContain("text-muted-foreground");
    expect(markup).not.toContain("text-gold-600");
  });
});
