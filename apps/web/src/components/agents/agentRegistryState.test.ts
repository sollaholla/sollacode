import { EnvironmentAuthorizationError, EnvironmentId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { describe, expect, it } from "vite-plus/test";

import {
  agentRegistryNoticeCopy,
  environmentIdFromUnknown,
  resolveAgentEnvironmentId,
  resolveAgentRegistryNotice,
  sortAgentEnvironments,
} from "./agentRegistryState";

describe("agent environment ordering", () => {
  const primary = EnvironmentId.make("primary");
  const remoteA = EnvironmentId.make("remote-a");
  const remoteB = EnvironmentId.make("remote-b");
  const entries = [
    { environmentId: remoteB, label: "SolomansComputer" },
    { environmentId: primary, label: "Soloman's MacBook Pro" },
    { environmentId: remoteA, label: "Another Host" },
  ];

  it("pins the primary host first and orders the rest by label", () => {
    expect(sortAgentEnvironments(entries, primary).map((entry) => entry.environmentId)).toEqual([
      primary,
      remoteA,
      remoteB,
    ]);
  });

  it("orders hosts independently of the order they arrive in", () => {
    // The regression this guards: ordering used to rank the focused route's
    // host first, so opening a thread on a remote host swapped the sidebar
    // sections around. Focus is no longer an input at all, and the remaining
    // inputs settle to one order however the environment list is shuffled.
    const expected = [primary, remoteA, remoteB];
    const permutations = [
      entries,
      entries.toReversed(),
      [entries[1]!, entries[2]!, entries[0]!],
      [entries[2]!, entries[0]!, entries[1]!],
    ];
    for (const permutation of permutations) {
      expect(
        sortAgentEnvironments(permutation, primary).map((entry) => entry.environmentId),
      ).toEqual(expected);
    }
  });

  it("is stable for hosts that share a label and independent of input order", () => {
    const duplicated = [
      { environmentId: remoteB, label: "Shared" },
      { environmentId: remoteA, label: "Shared" },
    ];
    expect(sortAgentEnvironments(duplicated, primary).map((entry) => entry.environmentId)).toEqual([
      remoteA,
      remoteB,
    ]);
    expect(
      sortAgentEnvironments(duplicated.toReversed(), primary).map((entry) => entry.environmentId),
    ).toEqual([remoteA, remoteB]);
  });

  it("falls back to label order when no primary host is known", () => {
    expect(sortAgentEnvironments(entries, null).map((entry) => entry.label)).toEqual([
      "Another Host",
      "Soloman's MacBook Pro",
      "SolomansComputer",
    ]);
  });
});

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
