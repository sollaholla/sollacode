import { ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { diffProviderStatuses, rememberProviderStatuses } from "./providerStatusPatch.ts";

const provider = (id: string, overrides: Record<string, unknown> = {}): ServerProvider =>
  ({
    instanceId: ProviderInstanceId.make(id),
    driver: "codex",
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-09-30T00:00:00.000Z",
    models: [{ slug: "m1", name: "M1", isCustom: false, capabilities: null }],
    slashCommands: Array.from({ length: 50 }, (_, index) => ({ name: `command-${index}` })),
    skills: [],
    ...overrides,
  }) as unknown as ServerProvider;

describe("diffProviderStatuses", () => {
  it("sends nothing when nothing changed, whatever the key order", () => {
    const a = provider("codex");
    const reordered = Object.fromEntries(
      Object.entries(a).toReversed(),
    ) as unknown as ServerProvider;
    expect(diffProviderStatuses(rememberProviderStatuses([a]), [reordered])).toBeNull();
  });

  it("sends a timestamp-only change as a patch a few dozen bytes long", () => {
    const before = provider("codex");
    const after = provider("codex", { checkedAt: "2026-09-30T00:05:00.000Z" });
    const diff = diffProviderStatuses(rememberProviderStatuses([before]), [after])!;
    expect(diff.upserted).toEqual([]);
    expect(diff.volatile).toEqual([
      { instanceId: after.instanceId, checkedAt: "2026-09-30T00:05:00.000Z" },
    ]);
    expect(JSON.stringify(diff).length).toBeLessThan(250);
  });

  it("patches only the usage fields that moved, and always carries checkedAt", () => {
    const before = provider("codex", { usageGuard: { state: "ok" }, accountUsage: { used: 1 } });
    const after = provider("codex", {
      usageGuard: { state: "ok" },
      accountUsage: { used: 2 },
      checkedAt: "2026-09-30T00:00:30.000Z",
    });
    const diff = diffProviderStatuses(rememberProviderStatuses([before]), [after])!;
    expect(diff.volatile).toEqual([
      {
        instanceId: after.instanceId,
        checkedAt: "2026-09-30T00:00:30.000Z",
        accountUsage: { used: 2 },
      },
    ]);
  });

  it("sends the whole provider when anything outside the volatile fields changed", () => {
    const before = provider("codex");
    const after = provider("codex", { status: "error", message: "signed out" });
    const diff = diffProviderStatuses(rememberProviderStatuses([before]), [after])!;
    expect(diff.volatile).toEqual([]);
    expect(diff.upserted).toEqual([after]);
  });

  it("sends the whole provider when a volatile field disappears, so it cannot linger", () => {
    const before = provider("codex", { usageGuard: { state: "ok" } });
    const after = provider("codex");
    const diff = diffProviderStatuses(rememberProviderStatuses([before]), [after])!;
    expect(diff.upserted).toEqual([after]);
    expect(diff.volatile).toEqual([]);
  });

  it("sends a new provider in full and reports removals through the order list", () => {
    const codex = provider("codex");
    const grok = provider("grok");
    const added = diffProviderStatuses(rememberProviderStatuses([codex]), [codex, grok])!;
    expect(added.upserted).toEqual([grok]);
    expect(added.order).toEqual([codex.instanceId, grok.instanceId]);

    const removed = diffProviderStatuses(rememberProviderStatuses([codex, grok]), [codex])!;
    expect(removed.upserted).toEqual([]);
    expect(removed.order).toEqual([codex.instanceId]);
  });

  it("reports a pure reorder", () => {
    const codex = provider("codex");
    const grok = provider("grok");
    const diff = diffProviderStatuses(rememberProviderStatuses([codex, grok]), [grok, codex])!;
    expect(diff.order).toEqual([grok.instanceId, codex.instanceId]);
    expect(diff.upserted).toEqual([]);
    expect(diff.volatile).toEqual([]);
  });
});
