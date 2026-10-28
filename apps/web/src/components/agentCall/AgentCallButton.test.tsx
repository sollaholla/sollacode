// @vitest-environment happy-dom

import {
  AgentCallId,
  EnvironmentId,
  VmAgentId,
  type AgentCall,
  type VmAgent,
} from "@t3tools/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  place: vi.fn(),
  calls: [] as Array<unknown>,
}));

vi.mock("@effect/atom-react", () => ({
  useAtomValue: () => ({ orchestrator: { openAiApiKeyConfigured: true } }),
}));
vi.mock("~/state/server", () => ({ serverEnvironment: { settingsValueAtom: () => null } }));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => mocks.navigate }));
vi.mock("~/agentCall/agentCallData", () => ({ useEnvironmentAgentCalls: () => mocks.calls }));
vi.mock("~/agentCall/AgentCallProvider", () => ({
  useAgentCallContext: () => ({
    activeCall: null,
    minimised: false,
    place: mocks.place,
    setMinimised: vi.fn(),
  }),
}));

import { AgentCallButton } from "./AgentCallButton";

const environmentId = EnvironmentId.make("host-1");
const nova = { vmAgentId: VmAgentId.make("agent-1"), name: "Nova" } as unknown as VmAgent;
const heldElsewhere: AgentCall = {
  callId: AgentCallId.make("call-7"),
  vmAgentId: VmAgentId.make("agent-1"),
  direction: "outgoing",
  reason: "user",
  topic: null,
  status: "active",
  answeredBy: "iPhone",
  createdAt: new Date().toISOString(),
  answeredAt: new Date().toISOString(),
  endedAt: null,
  expiresAt: null,
};

let container: HTMLDivElement;
let root: Root;

function click() {
  const found = container.querySelector<HTMLButtonElement>('[data-testid="agent-call-button"]');
  if (!found) throw new Error("No call button");
  act(() => found.click());
  return found;
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("AgentCallButton", () => {
  it("calls the agent when it is free", () => {
    mocks.calls = [{ ...heldElsewhere, status: "ended" }];
    act(() => root.render(<AgentCallButton environmentId={environmentId} agent={nova} />));
    click();
    expect(mocks.place).toHaveBeenCalledWith(environmentId, nova);
    expect(mocks.navigate).not.toHaveBeenCalled();
  });

  it("opens the call another device holds instead of failing to place a second one", () => {
    mocks.calls = [heldElsewhere];
    act(() => root.render(<AgentCallButton environmentId={environmentId} agent={nova} />));
    const button = click();
    expect(button.getAttribute("aria-label")).toBe("Open the call with Nova");
    expect(button.getAttribute("title")).toBe("On a call with Nova on iPhone");
    expect(mocks.place).not.toHaveBeenCalled();
    expect(mocks.navigate).toHaveBeenCalledWith({
      to: "/call/$environmentId/$callId",
      params: { environmentId: "host-1", callId: "call-7" },
    });
  });
});
