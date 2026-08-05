import type { EnvironmentId, ProviderDriverKind, ServerProvider } from "@t3tools/contracts";
import { create } from "zustand";

export const PROVIDER_USAGE_STORAGE_KEY = "solla:provider-usage:v2";
export const PROVIDER_USAGE_STALE_AFTER_MS = 15 * 60_000;

export interface PersistedProviderUsageWindow {
  readonly key: string;
  readonly label: string;
  readonly usedPercent: number | null;
  readonly resetAt: number | null;
  /**
   * Length of the quota window. Providers report only when a window *resets*, so
   * this is what lets the UI recover when it started (`resetAt - duration`) and
   * chart elapsed time against consumption. Null when the length is unknown.
   */
  readonly windowDurationMs?: number | null;
  readonly detail?: string;
}

export interface PersistedProviderUsageEntry {
  readonly accountKey: string;
  readonly driver: ProviderDriverKind;
  readonly windows: readonly PersistedProviderUsageWindow[];
  readonly reportedAt: string;
}

const CODEX_RESET_TIME_JITTER_MS = 60_000;

function mergeUsageWindow(
  driver: ProviderDriverKind,
  previous: PersistedProviderUsageWindow | undefined,
  next: PersistedProviderUsageWindow,
  reportedAt: string,
): PersistedProviderUsageWindow {
  if (
    driver !== "codex" ||
    previous?.usedPercent === null ||
    previous?.usedPercent === undefined ||
    next.usedPercent === null ||
    next.usedPercent >= previous.usedPercent ||
    // Older builds could invert Codex's remaining percentage and poison any
    // persisted value near the top of the window (for example, 90% remaining
    // became 98% used after subsequent refreshes). A fresh non-zero snapshot is
    // authoritative. The provider's known unreliable value is a transient 0%,
    // which stays guarded by the reset-cycle checks below.
    next.usedPercent > 0
  ) {
    return next;
  }

  const reportedAtMs = Date.parse(reportedAt);
  const nextCycleIsLater =
    previous.resetAt !== null &&
    next.resetAt !== null &&
    next.resetAt > previous.resetAt + CODEX_RESET_TIME_JITTER_MS;
  const previousCycleElapsed =
    previous.resetAt !== null &&
    Number.isFinite(reportedAtMs) &&
    reportedAtMs >= previous.resetAt - CODEX_RESET_TIME_JITTER_MS;

  // Ignore a transient zero unless the old window has elapsed and the provider
  // also advances the reset timestamp to a later cycle.
  return nextCycleIsLater && previousCycleElapsed ? next : previous;
}

interface ProviderUsageState {
  readonly byAccountKey: Readonly<Record<string, PersistedProviderUsageEntry>>;
  record: (entry: PersistedProviderUsageEntry) => void;
}

function normalizeIdentityPart(value: string): string {
  return value.trim().toLocaleLowerCase().replace(/\s+/g, " ");
}

/**
 * Uses only provider-reported public account metadata. Tokens, home paths,
 * cookies, and credentials never participate in the key or persisted value.
 */
export function providerUsageAccountKey(
  provider: ServerProvider,
  environmentId?: EnvironmentId,
): string | null {
  if (provider.auth.status !== "authenticated") return null;
  let accountKey: string;
  if (provider.auth.email) {
    accountKey = `${provider.driver}:account:${normalizeIdentityPart(provider.auth.email)}`;
  } else {
    // Labels describe plans/auth methods and can be shared by many accounts.
    // Without a provider-reported email, keep usage isolated to the configured
    // instance because a cross-instance account match cannot be proven.
    accountKey = `${provider.driver}:instance:${provider.instanceId}:type:${normalizeIdentityPart(
      provider.auth.type ?? "authenticated",
    )}`;
  }
  // Provider accounts and instance IDs are not globally unique across hosts.
  // Scope persisted usage to its authoritative environment so a remote tab can
  // never inherit a same-account snapshot reported by the local machine.
  return environmentId ? `${environmentId}\u0000${accountKey}` : accountKey;
}

export function mergeProviderUsageEntry(
  state: Readonly<Record<string, PersistedProviderUsageEntry>>,
  entry: PersistedProviderUsageEntry,
): Readonly<Record<string, PersistedProviderUsageEntry>> {
  const previous = state[entry.accountKey];
  const windowsByKey = new Map(
    (previous?.windows ?? []).map((window) => [window.key, window] as const),
  );
  const entryIsOlder = previous !== undefined && previous.reportedAt > entry.reportedAt;
  for (const window of entry.windows) {
    if (!entryIsOlder || !windowsByKey.has(window.key)) {
      windowsByKey.set(
        window.key,
        mergeUsageWindow(entry.driver, windowsByKey.get(window.key), window, entry.reportedAt),
      );
    }
  }
  const merged = {
    ...entry,
    windows: Array.from(windowsByKey.values()),
    reportedAt:
      previous && previous.reportedAt > entry.reportedAt ? previous.reportedAt : entry.reportedAt,
  };
  if (previous && JSON.stringify(previous) === JSON.stringify(merged)) return state;
  return { ...state, [entry.accountKey]: merged };
}

function isPersistedWindow(value: unknown): value is PersistedProviderUsageWindow {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<PersistedProviderUsageWindow>;
  return (
    typeof candidate.key === "string" &&
    candidate.key.length > 0 &&
    typeof candidate.label === "string" &&
    candidate.label.length > 0 &&
    (candidate.usedPercent === null ||
      (typeof candidate.usedPercent === "number" &&
        Number.isFinite(candidate.usedPercent) &&
        candidate.usedPercent >= 0 &&
        candidate.usedPercent <= 100)) &&
    (candidate.resetAt === null ||
      (typeof candidate.resetAt === "number" &&
        Number.isFinite(candidate.resetAt) &&
        candidate.resetAt > 0)) &&
    (candidate.windowDurationMs === undefined ||
      candidate.windowDurationMs === null ||
      (typeof candidate.windowDurationMs === "number" &&
        Number.isFinite(candidate.windowDurationMs) &&
        candidate.windowDurationMs > 0)) &&
    (candidate.detail === undefined || typeof candidate.detail === "string")
  );
}

function parseStoredEntries(): Readonly<Record<string, PersistedProviderUsageEntry>> {
  if (typeof window === "undefined") return {};
  try {
    const value = JSON.parse(window.localStorage.getItem(PROVIDER_USAGE_STORAGE_KEY) ?? "{}");
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(
      Object.entries(value).filter((entry): entry is [string, PersistedProviderUsageEntry] => {
        const candidate = entry[1] as Partial<PersistedProviderUsageEntry> | null;
        return (
          entry[0].length > 0 &&
          candidate !== null &&
          typeof candidate === "object" &&
          candidate.accountKey === entry[0] &&
          typeof candidate.driver === "string" &&
          Array.isArray(candidate.windows) &&
          candidate.windows.every(isPersistedWindow) &&
          typeof candidate.reportedAt === "string" &&
          Number.isFinite(Date.parse(candidate.reportedAt))
        );
      }),
    );
  } catch {
    return {};
  }
}

function persistEntries(entries: Readonly<Record<string, PersistedProviderUsageEntry>>): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(PROVIDER_USAGE_STORAGE_KEY, JSON.stringify(entries));
  } catch {
    // Usage display is best-effort and must not disrupt chat on storage errors.
  }
}

export const useProviderUsageStore = create<ProviderUsageState>((set) => ({
  byAccountKey: parseStoredEntries(),
  record: (entry) =>
    set((state) => {
      const byAccountKey = mergeProviderUsageEntry(state.byAccountKey, entry);
      if (byAccountKey === state.byAccountKey) return state;
      persistEntries(byAccountKey);
      return { byAccountKey };
    }),
}));

export function resetProviderUsageStoreForTests(): void {
  useProviderUsageStore.setState({ byAccountKey: {} });
}
