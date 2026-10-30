// @vitest-environment happy-dom

import { EnvironmentId, VmAgentId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

// The dialog's scroll area queries browser animations; happy-dom has none.
if (typeof Element.prototype.getAnimations !== "function") {
  Element.prototype.getAnimations = () => [];
}

const rename =
  vi.fn<
    (
      _request: unknown,
    ) => Promise<
      | { readonly _tag: "Success" }
      | { readonly _tag: "Failure"; readonly cause: Cause.Cause<Error> }
    >
  >();
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => rename }));
vi.mock("../../state/vmAgents", () => ({ vmAgentEnvironment: { rename: {} } }));

import { RenameAgentDialog } from "./RenameAgentDialog";

const onClose = vi.fn();
let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => {
  rename.mockReset().mockResolvedValue({ _tag: "Success" });
  onClose.mockReset();
});
afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

async function render() {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <RenameAgentDialog
        environmentId={EnvironmentId.make("remote-host")}
        agent={{
          vmAgentId: VmAgentId.make("agent-1"),
          name: "Personal Assistant",
          handle: "personal-assistant",
        }}
        onClose={onClose}
      />,
    );
  });
}
function input() {
  return document.querySelector("input")!;
}
function button(label: string) {
  return [...document.querySelectorAll("button")].find((entry) => entry.textContent === label)!;
}
async function type(value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input(), value);
    input().dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("RenameAgentDialog", () => {
  it("starts with the saved name and submits the trimmed name to the correct host", async () => {
    await render();
    expect(input().value).toBe("Personal Assistant");
    expect(document.body.textContent).toContain("mention handle stays @personal-assistant");
    await type("  Operations Assistant  ");
    await act(async () => button("Save name").click());
    expect(rename).toHaveBeenCalledExactlyOnceWith({
      environmentId: "remote-host",
      input: { vmAgentId: "agent-1", name: "Operations Assistant" },
    });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("blocks empty or overlong names without sending a command", async () => {
    await render();
    for (const value of ["   ", "a".repeat(65)]) {
      await type(value);
      expect(button("Save name").disabled).toBe(true);
      await act(async () =>
        input().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })),
      );
    }
    expect(rename).not.toHaveBeenCalled();
  });

  it("shows a conflict without closing and allows a corrected retry", async () => {
    rename.mockResolvedValueOnce({
      _tag: "Failure",
      cause: Cause.fail(new Error("An agent with that name already exists.")),
    });
    await render();
    await type("Occupied");
    await act(async () => button("Save name").click());
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("already exists");
    expect(onClose).not.toHaveBeenCalled();
    await type("Available");
    await act(async () => button("Save name").click());
    expect(rename).toHaveBeenCalledTimes(2);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("does not duplicate an in-flight save or dismiss it with Cancel", async () => {
    let complete: ((value: { _tag: "Success" }) => void) | undefined;
    rename.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    await render();
    await type("New name");
    await act(async () => {
      button("Save name").click();
      input().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(rename).toHaveBeenCalledOnce();
    expect(button("Saving…").disabled).toBe(true);
    expect(button("Cancel").disabled).toBe(true);
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => complete?.({ _tag: "Success" }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("cancels without changing the agent", async () => {
    await render();
    await type("Discard me");
    await act(async () => button("Cancel").click());
    expect(rename).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("closes an unchanged name without sending a command", async () => {
    await render();
    await act(async () => button("Save name").click());
    expect(rename).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledOnce();
  });
});
