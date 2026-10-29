// @vitest-environment happy-dom

import { EnvironmentId, VmAgentId, VmId, type VmAgent } from "@t3tools/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const setVoice = vi.fn(async (_request: unknown) => ({ _tag: "Success" as const }));

vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => setVoice }));
vi.mock("../../state/vmAgents", () => ({ vmAgentEnvironment: { setVoice: {} } }));

import { Menu, MenuPopup, MenuTrigger } from "../ui/menu";
import { AgentVoiceMenu } from "./AgentVoiceMenu";

const agent: VmAgent = {
  vmAgentId: VmAgentId.make("agent-1"),
  name: "Gregg",
  handle: "gregg",
  purpose: "Help.",
  icon: null,
  avatarColor: 2,
  voice: null,
  vmId: VmId.make("vm-1"),
  threadId: null,
  status: "running",
  controlMode: "agent",
  guestIp: null,
  lastError: null,
  createdAt: "2026-10-28T00:00:00.000Z",
  updatedAt: "2026-10-28T00:00:00.000Z",
};

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  setVoice.mockClear();
});

describe("AgentVoiceMenu", () => {
  it("opens the voice list from the agent menu and chooses a voice", async () => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(
        <Menu open>
          <MenuTrigger>Agent tools</MenuTrigger>
          <MenuPopup>
            <AgentVoiceMenu environmentId={EnvironmentId.make("host-1")} agent={agent} />
          </MenuPopup>
        </Menu>,
      );
    });
    const trigger = [...document.querySelectorAll("[data-slot=menu-sub-trigger]")][0];
    expect(trigger?.textContent).toContain("Call voice");
    expect(trigger?.textContent).toContain("Willow");
    // Opening the submenu used to throw Base UI error #31 (a label outside its group).
    await act(async () => {
      (trigger as HTMLElement).click();
    });
    const items = [...document.querySelectorAll("[data-slot=menu-radio-item]")];
    expect(items.map((item) => item.textContent)).toContain("AutomaticWillow, from its look");
    expect(document.body.textContent).toContain("Gregg speaks with");
    const vesper = items.find((item) => item.textContent?.startsWith("Vesper"));
    await act(async () => {
      (vesper as HTMLElement).click();
    });
    expect(setVoice).toHaveBeenCalledWith({
      environmentId: "host-1",
      input: { vmAgentId: "agent-1", voice: "vesper" },
    });
  });
});
