import { describe, expect, it } from "@effect/vitest";

import { resolveAcpRequestedModeId } from "./AcpSessionModes.ts";

const mockModeState = {
  currentModeId: "ask",
  availableModes: [
    { id: "ask", name: "Ask", description: "Request permission before making any changes" },
    {
      id: "architect",
      name: "Architect",
      description: "Design and plan software systems without implementation",
    },
    { id: "code", name: "Code", description: "Write and modify code with full tool access" },
  ],
};

describe("resolveAcpRequestedModeId", () => {
  it("maps plan interaction mode onto the advertised plan/architect session mode", () => {
    expect(
      resolveAcpRequestedModeId({
        interactionMode: "plan",
        runtimeMode: "full-access",
        modeState: mockModeState,
      }),
    ).toBe("architect");
  });

  it("maps full-access build and agent onto the advertised implement session mode", () => {
    expect(
      resolveAcpRequestedModeId({
        interactionMode: "default",
        runtimeMode: "full-access",
        modeState: mockModeState,
      }),
    ).toBe("code");
    expect(
      resolveAcpRequestedModeId({
        interactionMode: "agent",
        runtimeMode: "full-access",
        modeState: mockModeState,
      }),
    ).toBe("code");
  });

  it("maps approval-required access onto the advertised ask session mode", () => {
    expect(
      resolveAcpRequestedModeId({
        interactionMode: "default",
        runtimeMode: "approval-required",
        modeState: mockModeState,
      }),
    ).toBe("ask");
  });

  it("skips mode selection when the agent advertised no session modes", () => {
    expect(
      resolveAcpRequestedModeId({
        interactionMode: "plan",
        runtimeMode: "full-access",
        modeState: undefined,
      }),
    ).toBeUndefined();
  });
});
