// @vitest-environment happy-dom

import { EnvironmentId, ThreadId, type VmAgent, VmAgentId, VmId } from "@t3tools/contracts";
import { AsyncResult } from "effect/unstable/reactivity";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  result: null as unknown,
  rules: vi.fn(() => Symbol.for("agent-rules-query")),
  updateRules: vi.fn(),
  updateToken: Symbol.for("agent-rules-update"),
}));

vi.mock("@effect/atom-react", () => ({
  useAtomValue: () => mocks.result,
}));

vi.mock("~/state/vmAgents", () => ({
  vmAgentEnvironment: {
    rules: mocks.rules,
    updateRules: mocks.updateToken,
  },
}));

vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: (command: unknown) => {
    if (command !== mocks.updateToken) throw new Error("Unexpected rules command token.");
    return mocks.updateRules;
  },
}));

import { AgentRulesPanel } from "./AgentRulesPanel";

const environmentId = EnvironmentId.make("environment-1");
const vmAgentId = VmAgentId.make("agent-1");
const agent: VmAgent = {
  vmAgentId,
  name: "Researcher",
  handle: "researcher",
  purpose: "Research durable product questions.",
  vmId: VmId.make("agent-1"),
  threadId: ThreadId.make("thread-1"),
  status: "running",
  controlMode: "agent",
  guestIp: null,
  lastError: null,
  createdAt: "2026-08-26T12:00:00.000Z",
  updatedAt: "2026-08-26T12:00:00.000Z",
};

let container: HTMLDivElement;
let root: Root;

function buttonNamed(name: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll("button")).find((candidate) =>
    candidate.textContent?.includes(name),
  );
  if (!(button instanceof HTMLButtonElement)) throw new Error(`Missing ${name} button.`);
  return button;
}

function rulesInput(): HTMLTextAreaElement {
  const input = container.querySelector('textarea[aria-label="Agent rules"]');
  if (!(input instanceof HTMLTextAreaElement)) throw new Error("Missing rules editor.");
  return input;
}

async function replaceRules(value: string): Promise<void> {
  const input = rulesInput();
  const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  if (!setValue) throw new Error("Missing native textarea value setter.");
  await act(async () => {
    setValue.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mocks.rules.mockClear();
  mocks.updateRules.mockReset();
  mocks.result = AsyncResult.success({
    vmAgentId,
    fileName: "AGENTS.md" as const,
    content: "# Existing rules\n",
    exists: true,
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("AgentRulesPanel", () => {
  it("loads AGENTS.md and saves one edited source of truth", async () => {
    mocks.updateRules.mockResolvedValue(
      AsyncResult.success({
        vmAgentId,
        fileName: "AGENTS.md" as const,
        content: "# Updated rules\n",
        exists: true,
      }),
    );

    await act(async () => {
      root.render(<AgentRulesPanel environmentId={environmentId} agent={agent} />);
    });

    expect(mocks.rules).toHaveBeenCalledWith({
      environmentId,
      input: { vmAgentId },
    });
    expect(rulesInput().value).toBe("# Existing rules\n");
    expect(container.textContent).toContain("CLAUDE.md points to it");

    await replaceRules("# Updated rules\n");
    await act(async () => {
      buttonNamed("Save").click();
      await Promise.resolve();
    });

    expect(mocks.updateRules).toHaveBeenCalledWith({
      environmentId,
      input: { vmAgentId, content: "# Updated rules\n" },
    });
    expect(rulesInput().value).toBe("# Updated rules\n");
    expect(buttonNamed("Save").disabled).toBe(true);
  });

  it("resets an unsaved draft without mutating the backend", async () => {
    await act(async () => {
      root.render(<AgentRulesPanel environmentId={environmentId} agent={agent} />);
    });

    await replaceRules("temporary edit");
    expect(buttonNamed("Reset").disabled).toBe(false);

    await act(async () => buttonNamed("Reset").click());

    expect(rulesInput().value).toBe("# Existing rules\n");
    expect(mocks.updateRules).not.toHaveBeenCalled();
    expect(buttonNamed("Reset").disabled).toBe(true);
  });
});
