import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import type { ProviderTask } from "../../providerTasks";
import { ProviderTaskPanel } from "../ProviderTaskPanel";
import { COMPOSER_STACK_SURFACE_CLASS_NAME } from "./composerStackSurface";
import { QueuedMessagesPanel } from "./QueuedMessagesPanel";

const task: ProviderTask = {
  taskId: "surface-task",
  taskType: "local_agent",
  title: "Background task",
  summary: "Running.",
  lastToolName: null,
  status: "running",
  startedAt: "2026-09-11T12:00:00.000Z",
  updatedAt: "2026-09-11T12:00:01.000Z",
  toolUses: 1,
};

/**
 * These two cards stack directly on top of each other above the composer, so
 * any difference between them reads as a bug rather than a distinction. The
 * queued-message card was full-width and opaque while the task panel was inset
 * and translucent, which is exactly what the owner reported seeing.
 */
describe("composer stack surface", () => {
  const containerClasses = (markup: string): string => /class="([^"]*)"/u.exec(markup)?.[1] ?? "";

  it("gives the queued-message card and the task panel the same container", () => {
    const queued = containerClasses(
      renderToStaticMarkup(
        <QueuedMessagesPanel
          count={1}
          failedCount={0}
          status="Joining the running turn"
          threadKey="surface-thread"
        >
          <div />
        </QueuedMessagesPanel>,
      ),
    );
    const tasks = containerClasses(renderToStaticMarkup(<ProviderTaskPanel tasks={[task]} />));

    for (const token of COMPOSER_STACK_SURFACE_CLASS_NAME.split(" ")) {
      expect(queued, `queued card is missing ${token}`).toContain(token);
      expect(tasks, `task panel is missing ${token}`).toContain(token);
    }
  });

  /**
   * Unifying the containers was not enough: the owner sent the same screenshot
   * back because the *handles* still differed — the queued card had a tall
   * left-aligned title block with the chevron on the right, while the task
   * panel had a compact muted bar with the chevron on the left, a live dot and
   * a count pill. They asked for one look, preferring the task panel's, so
   * both now render the same header component and this pins that.
   */
  it("gives both cards the background-task panel's collapse handle", () => {
    const queued = renderToStaticMarkup(
      <QueuedMessagesPanel
        count={1}
        failedCount={0}
        status="Joining the running turn"
        threadKey="surface-thread"
      >
        <div />
      </QueuedMessagesPanel>,
    );
    const tasks = renderToStaticMarkup(<ProviderTaskPanel tasks={[task]} />);

    for (const markup of [queued, tasks]) {
      // The compact muted bar, not a tall title block.
      expect(markup).toContain("min-h-9");
      expect(markup).toContain("bg-muted/20");
      // The chevron sits inside the pointer-events-none content row, so the
      // absolutely-positioned peer button is what takes the click.
      expect(markup).toContain("peer absolute inset-0");
      // The live dot and the count pill on the right.
      expect(markup).toContain("bg-sky-500");
      expect(markup).toContain("rounded-full bg-muted px-1.5 py-0.5");
    }

    // And the handle stays below its list on both, so the stack grows upward
    // toward the transcript rather than pushing the composer down.
    expect(queued).toContain("flex-col-reverse");
    expect(tasks).toContain("flex-col-reverse");
  });

  it("keeps the cards inset and translucent rather than full-width and opaque", () => {
    // The two properties that actually differed. An inset overlay reads as
    // floating above the transcript; a full-width opaque card reads as part of
    // it, which is the mismatch that prompted this.
    expect(COMPOSER_STACK_SURFACE_CLASS_NAME).toContain("w-[calc(100%-2.75rem)]");
    expect(COMPOSER_STACK_SURFACE_CLASS_NAME).toContain("bg-background/95");
    expect(COMPOSER_STACK_SURFACE_CLASS_NAME).toContain("backdrop-blur");
    expect(COMPOSER_STACK_SURFACE_CLASS_NAME).not.toContain("bg-card");
    expect(COMPOSER_STACK_SURFACE_CLASS_NAME).not.toContain("w-full");
  });
});
