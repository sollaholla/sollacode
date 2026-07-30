import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  createProviderUsageRefreshCoordinator,
  isProviderUsageRefreshEligible,
  ProviderUsageRefreshBackoffError,
} from "./providerUsageRefresh";

function provider(
  overrides: Partial<ServerProvider> & Pick<ServerProvider, "driver" | "instanceId">,
): ServerProvider {
  return {
    displayName: String(overrides.driver),
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-07-29T15:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    ...overrides,
  };
}

const codex = () =>
  provider({
    driver: ProviderDriverKind.make("codex"),
    instanceId: ProviderInstanceId.make("codex"),
  });

describe("provider settings usage refresh coordinator", () => {
  it("only refreshes enabled, available, potentially authenticated supported providers", () => {
    expect(isProviderUsageRefreshEligible(codex())).toBe(true);
    expect(isProviderUsageRefreshEligible({ ...codex(), enabled: false })).toBe(false);
    expect(isProviderUsageRefreshEligible({ ...codex(), status: "disabled" })).toBe(false);
    expect(
      isProviderUsageRefreshEligible({
        ...codex(),
        auth: { status: "unauthenticated" },
      }),
    ).toBe(false);
    expect(
      isProviderUsageRefreshEligible({
        ...codex(),
        availability: "unavailable",
      }),
    ).toBe(false);
    expect(
      isProviderUsageRefreshEligible({
        ...codex(),
        driver: ProviderDriverKind.make("cursor"),
      }),
    ).toBe(false);
  });

  it("deduplicates the same instance and serializes different provider refreshes", async () => {
    const completions = new Map<string, () => void>();
    const refresh = vi.fn(
      (instanceId: ProviderInstanceId) =>
        new Promise<void>((resolve) => {
          completions.set(String(instanceId), resolve);
        }),
    );
    const coordinator = createProviderUsageRefreshCoordinator({ refresh });
    const claude = provider({
      driver: ProviderDriverKind.make("claudeAgent"),
      instanceId: ProviderInstanceId.make("claude-personal"),
    });

    const firstCodex = coordinator.request(codex());
    const duplicateCodex = coordinator.request(codex());
    const claudeRequest = coordinator.request(claude);
    await Promise.resolve();

    expect(firstCodex).toBe(duplicateCodex);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenNthCalledWith(1, ProviderInstanceId.make("codex"));

    completions.get("codex")?.();
    await firstCodex;
    await Promise.resolve();
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(refresh).toHaveBeenNthCalledWith(2, ProviderInstanceId.make("claude-personal"));

    completions.get("claude-personal")?.();
    await claudeRequest;
  });

  it("backs off failed refreshes while allowing a newly enabled provider to refresh", async () => {
    let now = 1_000;
    const refresh = vi
      .fn<(instanceId: ProviderInstanceId) => Promise<void>>()
      .mockRejectedValueOnce(new Error("provider unavailable"))
      .mockResolvedValue(undefined);
    const coordinator = createProviderUsageRefreshCoordinator({
      refresh,
      now: () => now,
      failureBackoffMs: 30_000,
    });

    await expect(coordinator.request(codex())).rejects.toThrow("provider unavailable");
    await expect(coordinator.request(codex())).rejects.toBeInstanceOf(
      ProviderUsageRefreshBackoffError,
    );
    expect(refresh).toHaveBeenCalledTimes(1);

    // Enabling is an explicit state transition. It gets one immediate probe
    // even when this instance failed before it was disabled.
    await expect(
      coordinator.request(codex(), { ignoreFailureBackoff: true }),
    ).resolves.toBeUndefined();
    expect(refresh).toHaveBeenCalledTimes(2);

    now += 30_001;
    await expect(coordinator.request(codex())).resolves.toBeUndefined();
    expect(refresh).toHaveBeenCalledTimes(3);
  });
});
