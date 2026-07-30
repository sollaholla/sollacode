import type { ProviderDriverKind, ServerProvider } from "@t3tools/contracts";
import { create } from "zustand";

export const PROVIDER_USAGE_STORAGE_KEY = "solla:provider-usage:v1";
export const PROVIDER_USAGE_STALE_AFTER_MS = 15 * 60_000;

export interface PersistedProviderUsageWindow {
  readonly key: string;
  readonly label: string;
  readonly usedPercent: number | null;
  readonly resetAt: number | null;
  readonly detail?: string;
}

export interface PersistedProviderUsageEntry {
  readonly accountKey: string;
  readonly driver: ProviderDriverKind;
  readonly windows: readonly PersistedProviderUsageWindow[];
  readonly reportedAt: string;
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
export function providerUsageAccountKey(provider: ServerProvider): string | null {
  if (provider.auth.status !== "authenticated") return null;
  if (provider.auth.email) {
    return `${provider.driver}:account:${normalizeIdentityPart(provider.auth.email)}`;
  }
  // Labels describe plans/auth methods and can be shared by many accounts.
  // Without a provider-reported email, keep usage isolated to the configured
  // instance because a cross-instance account match cannot be proven.
  return `${provider.driver}:instance:${provider.instanceId}:type:${normalizeIdentityPart(
    provider.auth.type ?? "authenticated",
  )}`;
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
      windowsByKey.set(window.key, window);
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
