import { EnvironmentAuthorizationError, EnvironmentId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { describe, expect, it } from "vite-plus/test";

import {
  agentRegistryNoticeCopy,
  environmentIdFromUnknown,
  resolveAgentEnvironmentId,
  resolveAgentRegistryNotice,
} from "./agentRegistryState";

describe("agent registry presentation", () => {
  it("targets the active route host before an agent deep-link or primary fallback", () => {
    const route = EnvironmentId.make("remote-route");
    const deepLink = EnvironmentId.make("remote-agent");
    const primary = EnvironmentId.make("primary");

    expect(
      resolveAgentEnvironmentId({
        routeEnvironmentId: route,
        searchEnvironmentId: deepLink,
        primaryEnvironmentId: primary,
      }),
    ).toBe(route);
    expect(
      resolveAgentEnvironmentId({
        routeEnvironmentId: null,
        searchEnvironmentId: deepLink,
        primaryEnvironmentId: primary,
      }),
    ).toBe(deepLink);
    expect(environmentIdFromUnknown("  remote-agent  ")).toBe(deepLink);
    expect(environmentIdFromUnknown(" ")).toBeNull();
  });

  it("does not report a stale empty registry as an authoritative no-agents result", () => {
    expect(
      resolveAgentRegistryNotice({
        hasSnapshot: true,
        agentCount: 0,
        failureCause: null,
        connectionPhase: "offline",
      }),
    ).toBe("disconnected");
    expect(
      resolveAgentRegistryNotice({
        hasSnapshot: true,
        agentCount: 0,
        failureCause: null,
        connectionPhase: "connected",
      }),
    ).toBe("empty");
  });

  it("distinguishes missing Agent access from transport unavailability", () => {
    const notice = resolveAgentRegistryNotice({
      hasSnapshot: false,
      agentCount: 0,
      failureCause: Cause.fail(
        new EnvironmentAuthorizationError({
          message: "missing scope",
          requiredScope: "vm:operate",
        }),
      ),
      connectionPhase: "connected",
    });

    expect(notice).toBe("unauthorized");
    expect(agentRegistryNoticeCopy("unauthorized")).toContain("vm:operate");
  });

  it("keeps a last-known Scout visible while its host reconnects", () => {
    expect(
      resolveAgentRegistryNotice({
        hasSnapshot: true,
        agentCount: 1,
        failureCause: Cause.fail(new Error("transport closed")),
        connectionPhase: "reconnecting",
      }),
    ).toBe("stale");
  });
});
