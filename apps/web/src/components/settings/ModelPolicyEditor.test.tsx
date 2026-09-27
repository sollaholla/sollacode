// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ProviderInstanceId, type ModelAccessPolicy } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { ModelPolicyEditor } from "./ModelPolicyEditor";

const viewport = vi.hoisted(() => ({ compact: true }));
vi.mock("../../hooks/useMediaQuery", () => ({ useMediaQuery: () => viewport.compact }));

describe("compact model restrictions", () => {
  let container: HTMLDivElement;
  let root: Root;
  const onSave = vi.fn(async (_policy: ModelAccessPolicy) => {});
  const policy: ModelAccessPolicy = {
    mode: "allow",
    models: ["first-model", "second-model"].map((model) => ({
      instanceId: ProviderInstanceId.make("codex"),
      model,
    })),
  };

  beforeEach(() => {
    viewport.compact = true;
    vi.clearAllMocks();
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
  async function render(value = policy) {
    await act(async () =>
      root.render(<ModelPolicyEditor policy={value} providers={[]} onSave={onSave} />),
    );
  }
  const toggle = () => container.querySelector<HTMLButtonElement>("button[aria-expanded]")!;

  it("starts with a selection summary and save action instead of a checklist on phones", async () => {
    await render();
    expect(toggle().textContent).toBe("Models · 2 selected");
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelector("input")).toBeNull();
    expect(container.textContent).toContain("Save restrictions");
  });

  it("keeps edits when collapsing and saves the exact provider-account selection", async () => {
    await render();
    await act(async () => toggle().click());
    expect(
      container.querySelector('input[aria-label="Search models for restrictions"]'),
    ).not.toBeNull();
    const checks = container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
    expect(checks).toHaveLength(2);
    expect(checks[0]!.checked).toBe(true);
    await act(async () => checks[0]!.click());
    expect(toggle().textContent).toBe("Models · 1 selected");
    await act(async () => toggle().click());
    expect(container.querySelector("input")).toBeNull();
    const save = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (b) => b.textContent === "Save restrictions",
    )!;
    await act(async () => save.click());
    expect(onSave).toHaveBeenCalledWith({ mode: "allow", models: [policy.models[1]] });
    expect(container.textContent).toContain("Restrictions saved.");
  });

  it("keeps the empty allowlist warning visible while collapsed", async () => {
    await render({ mode: "allow", models: [] });
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
    expect(container.textContent).toContain("No models are allowed. Work will wait");
  });

  it("shows the full checklist on desktop without requiring an extra click", async () => {
    viewport.compact = false;
    await render();
    expect(toggle()).toBeNull();
    expect(container.querySelectorAll('input[type="checkbox"]')).toHaveLength(2);
  });

  it("does not offer a checklist when all models are allowed", async () => {
    await render({ mode: "all", models: [] });
    expect(toggle()).toBeNull();
    expect(container.querySelector("input")).toBeNull();
    expect(container.textContent).not.toContain("No models are allowed");
  });
});
