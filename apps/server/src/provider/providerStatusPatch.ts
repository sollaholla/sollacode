import {
  SERVER_PROVIDER_VOLATILE_FIELDS,
  type ProviderInstanceId,
  type ServerConfigProviderStatusesPatchPayload,
  type ServerProvider,
  type ServerProviderVolatilePatch,
} from "@t3tools/contracts";

const VOLATILE = new Set<string>(SERVER_PROVIDER_VOLATILE_FIELDS);

/** Key-order-independent JSON, so two equal snapshots never look different. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .toSorted(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** What one subscriber was last told about each provider. */
export type ProviderStatusMemory = ReadonlyMap<ProviderInstanceId, ServerProvider>;

export const rememberProviderStatuses = (
  providers: ReadonlyArray<ServerProvider>,
): ProviderStatusMemory => new Map(providers.map((provider) => [provider.instanceId, provider]));

/**
 * The smallest message that brings a subscriber from `previous` to `next`, or
 * null when nothing it can see changed.
 *
 * A provider that differs only in its volatile fields (a health-check
 * timestamp, a usage tick) becomes a few hundred bytes instead of its whole
 * catalogue. Anything else, including a volatile field disappearing, is sent
 * in full: the allowlist is what may be patched, never what may be skipped.
 */
export function diffProviderStatuses(
  previous: ProviderStatusMemory,
  next: ReadonlyArray<ServerProvider>,
): ServerConfigProviderStatusesPatchPayload | null {
  const upserted: ServerProvider[] = [];
  const volatile: ServerProviderVolatilePatch[] = [];
  for (const provider of next) {
    const before = previous.get(provider.instanceId);
    if (before === undefined) {
      upserted.push(provider);
      continue;
    }
    const now = provider as Record<string, unknown>;
    const was = before as Record<string, unknown>;
    const changed = new Set<string>();
    for (const key of new Set([...Object.keys(now), ...Object.keys(was)])) {
      if (canonicalJson(now[key]) !== canonicalJson(was[key])) changed.add(key);
    }
    if (changed.size === 0) continue;
    const removedVolatile = [...changed].some((key) => now[key] === undefined);
    if (removedVolatile || [...changed].some((key) => !VOLATILE.has(key))) {
      upserted.push(provider);
      continue;
    }
    volatile.push({
      instanceId: provider.instanceId,
      // Always carried: "last checked" must move even when nothing else did.
      checkedAt: provider.checkedAt,
      ...(changed.has("accountUsage") ? { accountUsage: provider.accountUsage } : {}),
      ...(changed.has("accountUsageReportedAt")
        ? { accountUsageReportedAt: provider.accountUsageReportedAt }
        : {}),
      ...(changed.has("accountUsageStatus")
        ? { accountUsageStatus: provider.accountUsageStatus }
        : {}),
      ...(changed.has("usageGuard") ? { usageGuard: provider.usageGuard } : {}),
      ...(changed.has("versionAdvisory") ? { versionAdvisory: provider.versionAdvisory } : {}),
    });
  }
  const order = next.map((provider) => provider.instanceId);
  const previousOrder = [...previous.keys()];
  const sameOrder =
    order.length === previousOrder.length &&
    order.every((instanceId, index) => previousOrder[index] === instanceId);
  if (upserted.length === 0 && volatile.length === 0 && sameOrder) return null;
  return { order, upserted, volatile };
}
