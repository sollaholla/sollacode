// @vitest-environment happy-dom
import {
  ProviderInstanceId,
  ProviderDriverKind,
  type ModelSelection,
  type ServerProvider,
} from "@t3tools/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { UsageGuardPausedBanner } from "./UsageGuardPausedBanner";
import { UsageGuardEffortSlider } from "./UsageGuardEffortSlider";
import { findUsageGuardPauseNotice } from "./usageGuardPause";
import { EventId } from "@t3tools/contracts";

const selection: ModelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-6-astra",
  options: [
    { id: "reasoningEffort", value: "high" },
    { id: "serviceTier", value: "priority" },
  ],
};
const provider: ServerProvider = {
  instanceId: selection.instanceId,
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  version: null,
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-09-06T18:00:00Z",
  slashCommands: [],
  skills: [],
  models: [
    {
      slug: selection.model,
      name: "Astra",
      isCustom: false,
      capabilities: {
        optionDescriptors: [
          {
            type: "select",
            id: "reasoningEffort",
            label: "Thinking effort",
            options: [
              { id: "high", label: "High" },
              { id: "medium", label: "Medium" },
              { id: "low", label: "Low" },
            ],
          },
        ],
      },
    },
  ],
};
let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
async function slide(value: string) {
  const input = container.querySelector("input")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
it("updates estimated wait and savings while dragging, then applies the selected effort", async () => {
  const apply = vi.fn();
  await act(async () =>
    root.render(
      <UsageGuardEffortSlider
        selection={selection}
        provider={provider}
        waitSeconds={600}
        nowMs={0}
        estimates={[{ model: selection.model, effort: "low", samples: 4, resumeAt: 120000 }]}
        onApply={apply}
        busy={false}
      />,
    ),
  );
  expect(container.querySelector("input")?.value).toBe("2");
  await slide("0");
  expect(container.textContent).toContain("Estimated time saved: +8m 0s");
  expect(container.textContent).toContain("Estimated wait: 2m 0s");
  expect(apply).not.toHaveBeenCalled();
  await act(async () => container.querySelector("button")!.click());
  expect(apply).toHaveBeenCalledWith({
    ...selection,
    options: [
      { id: "serviceTier", value: "priority" },
      { id: "reasoningEffort", value: "low" },
    ],
  });
  await slide("1");
  expect(container.textContent).toContain("waiting for budget estimate");
  expect(container.textContent).not.toContain("8m 0s");
});
it("opens only by click and resumes with the applied setting, not the slider preview", async () => {
  const resume = vi.fn();
  const notice = findUsageGuardPauseNotice([
    {
      id: EventId.make("pause"),
      kind: "usage-guard.paused",
      tone: "info",
      summary: "Waiting",
      payload: {},
      createdAt: "2026-09-06T18:00:00Z",
      turnId: null,
    },
  ])!;
  await act(async () =>
    root.render(
      <UsageGuardPausedBanner
        notice={notice}
        selection={selection}
        provider={provider}
        onApplyEffort={vi.fn()}
        onResume={resume}
        resuming={false}
      />,
    ),
  );
  const trigger = container.querySelector("button[aria-expanded]")!;
  await act(async () => trigger.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })));
  expect(container.querySelector("input")).toBeNull();
  await act(async () => trigger.dispatchEvent(new MouseEvent("click", { bubbles: true })));
  await slide("0");
  expect(trigger.getAttribute("aria-expanded")).toBe("true");
  expect(container.textContent).toContain("Thinking effort: Low");
  await act(async () =>
    container.querySelector<HTMLButtonElement>("button[aria-label^='Resume now despite']")!.click(),
  );
  // The preview is not applied: Resume carries no selection, so the server
  // runs whatever effort is actually set on the thread.
  expect(resume).toHaveBeenCalledTimes(1);
  expect(resume.mock.calls[0]).toEqual([]);
  expect(container.textContent).toContain("Resume uses the applied setting");
});
it("does not borrow effort choices from a different model", async () => {
  await act(async () =>
    root.render(
      <UsageGuardEffortSlider
        selection={{ ...selection, model: "unsupported" }}
        provider={provider}
        waitSeconds={30}
        onApply={vi.fn()}
        busy={false}
      />,
    ),
  );
  expect(container.querySelector("input")).toBeNull();
  expect(container.textContent).toContain("does not expose");
});

it("shows increased waits in red and applies an alternative model quote", async () => {
  const apply = vi.fn();
  await act(async () =>
    root.render(
      <UsageGuardEffortSlider
        selection={{ ...selection, options: [{ id: "reasoningEffort", value: "low" }] }}
        provider={provider}
        waitSeconds={120}
        nowMs={0}
        busy={false}
        onApply={apply}
        estimates={[
          { model: selection.model, effort: "high", samples: 0, resumeAt: 600000 },
          {
            model: "regular-model",
            effort: "high",
            optionId: "effort",
            windowLabel: "Shared weekly",
            samples: 0,
            resumeAt: 0,
          },
        ]}
      />,
    ),
  );
  await slide("2");
  const negative = [...container.querySelectorAll("span")].find((element) =>
    element.textContent?.includes("longer wait"),
  );
  expect(negative?.textContent).toContain("−8m 0s saved");
  expect(negative?.className).toContain("text-red-600");
  expect(container.textContent).toContain("Ready now · ↗ +2m 0s · high · Shared weekly");
  await act(async () =>
    [...container.querySelectorAll("button")]
      .find((button) => button.getAttribute("aria-label") === "Use regular-model")!
      .click(),
  );
  expect(apply).toHaveBeenCalledWith({
    instanceId: selection.instanceId,
    model: "regular-model",
    options: [{ id: "effort", value: "high" }],
  });
});

it("confirms before cancelling the hold and does not fake a saving on the current effort", async () => {
  const cancel = vi.fn();
  const resume = vi.fn();
  const notice = findUsageGuardPauseNotice([
    {
      id: EventId.make("pause"),
      kind: "usage-guard.paused",
      tone: "info",
      summary: "Waiting",
      payload: {},
      createdAt: "2026-09-06T18:00:00Z",
      turnId: null,
    },
  ])!;
  await act(async () =>
    root.render(
      <UsageGuardPausedBanner
        notice={notice}
        selection={selection}
        provider={provider}
        onApplyEffort={vi.fn()}
        onResume={resume}
        onCancel={cancel}
        resuming={false}
      />,
    ),
  );
  const trigger = container.querySelector("button[aria-expanded]")!;
  await act(async () => trigger.dispatchEvent(new MouseEvent("click", { bubbles: true })));
  expect(container.textContent).toContain("Current setting");
  expect(container.textContent).not.toContain("Estimated time saved: 0s");
  await act(async () =>
    container
      .querySelector<HTMLButtonElement>("button[aria-label='Cancel the held work']")!
      .click(),
  );
  expect(cancel).not.toHaveBeenCalled();
  expect(document.body.textContent).toContain("Cancel this held work?");
  await act(async () =>
    [...document.body.querySelectorAll("button")]
      .find((button) => button.textContent === "Cancel held work")!
      .click(),
  );
  expect(cancel).toHaveBeenCalledTimes(1);
  expect(resume).not.toHaveBeenCalled();
});

it("explains a genuinely unchanged wait and orders every quoted model by shortest wait", async () => {
  await act(async () =>
    root.render(
      <UsageGuardEffortSlider
        selection={selection}
        provider={provider}
        waitSeconds={600}
        nowMs={0}
        busy={false}
        onApply={vi.fn()}
        estimates={[
          { model: selection.model, effort: "low", samples: 4, resumeAt: 600000 },
          { model: "slow-model", effort: "low", samples: 4, resumeAt: 900000 },
          { model: "quick-model", effort: "low", samples: 4, resumeAt: 60000 },
          { model: "unknown-model", effort: "low", samples: 4, resumeAt: null },
        ]}
      />,
    ),
  );
  await slide("0");
  expect(container.textContent).toContain("Same wait · already-spent usage sets this hold");
  expect(container.textContent).toContain("Compare other models (3)");
  const quoted = [...container.querySelectorAll("p.font-medium")]
    .map((element) => element.textContent)
    .filter((text) => text?.endsWith("-model"));
  expect(quoted).toEqual(["quick-model", "slow-model", "unknown-model"]);
});

it("never shows a saving for a higher effort when the banner countdown lags the estimates", async () => {
  await act(async () =>
    root.render(
      <UsageGuardEffortSlider
        selection={{ ...selection, options: [{ id: "reasoningEffort", value: "low" }] }}
        provider={provider}
        // Stale countdown from before an Apply: shorter than every estimate.
        waitSeconds={300}
        nowMs={0}
        busy={false}
        onApply={vi.fn()}
        estimates={[
          { model: selection.model, effort: "low", samples: 4, resumeAt: 600000 },
          { model: selection.model, effort: "medium", samples: 4, resumeAt: 600000 },
          { model: selection.model, effort: "high", samples: 4, resumeAt: 720000 },
          { model: "other-model", effort: "low", samples: 4, resumeAt: 480000 },
        ]}
      />,
    ),
  );
  await slide("1");
  expect(container.textContent).toContain("Thinking effort: Medium");
  expect(container.textContent).toContain("Same wait");
  expect(container.textContent).not.toContain("Estimated time saved: +");
  await slide("2");
  expect(container.textContent).toContain("−2m 0s saved (longer wait)");
  // The other model's saving is measured against the same baseline, not the stale countdown.
  expect(container.textContent).toContain("↗ +2m 0s");
});

it("shows the reading's age with a Refresh control and prefers a newer live reading", async () => {
  const refresh = vi.fn();
  const notice = findUsageGuardPauseNotice([
    {
      id: EventId.make("pause"),
      kind: "usage-guard.paused",
      tone: "info",
      summary: "Waiting",
      payload: { detail: "Old reading: 1368 credits left", reportedAt: "2026-09-06T18:00:00Z" },
      createdAt: "2026-09-06T18:00:00Z",
      turnId: null,
    },
  ])!;
  const liveProvider: ServerProvider = {
    ...provider,
    usageGuard: {
      enabled: true,
      tier: "pause",
      summary: "Holding new work · 0.0 credits remain",
      windowKey: "paid-credits",
      windowLabel: "paid credits",
      reportedPercent: 100,
      estimatedPercent: 100,
      resetsAt: null,
      burnPercentPerHour: null,
      projectedAtResetPercent: null,
      turnCostPercent: null,
      headroomPercent: 3,
      effortTarget: null,
      backgroundBudget: 0,
      activeThreads: 0,
      holdingBackgroundWork: true,
      backgroundCooldownMs: null,
      tokensPerPercent: 1,
      tokensPerPercentSource: "default",
      learnedTokensPerPercent: null,
      tokensSinceReport: 0,
      updatedAt: "2026-09-06T19:00:00Z",
    },
  };
  await act(async () =>
    root.render(
      <UsageGuardPausedBanner
        notice={notice}
        selection={selection}
        provider={liveProvider}
        onApplyEffort={vi.fn()}
        onResume={vi.fn()}
        onRefresh={refresh}
        resuming={false}
      />,
    ),
  );
  // The newer live reading replaces the one frozen into the notice.
  expect(container.textContent).toContain("0.0 credits remain");
  expect(container.textContent).not.toContain("1368 credits left");
  const trigger = container.querySelector("button[aria-expanded]")!;
  await act(async () => trigger.dispatchEvent(new MouseEvent("click", { bubbles: true })));
  expect(container.textContent).toMatch(/Reading .*ago/);
  await act(async () =>
    container
      .querySelector<HTMLButtonElement>("button[aria-label='Refresh usage reading']")!
      .click(),
  );
  expect(refresh).toHaveBeenCalledTimes(1);
});
