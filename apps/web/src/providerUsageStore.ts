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

export interface PersistedProviderUsageResetCredit {
  readonly id: string | null;
  readonly title: string;
  readonly description: string | null;
  readonly expiresAt: number | null;
}

export interface PersistedProviderUsageResetCredits {
  readonly availableCount: number;
  readonly credits: readonly PersistedProviderUsageResetCredit[];
}

export interface PersistedProviderUsageEntry {
  readonly accountKey: string;
  readonly driver: ProviderDriverKind;
  readonly windows: readonly PersistedProviderUsageWindow[];
  readonly reportedAt: string;
  readonly resetCredits?: PersistedProviderUsageResetCredits | null;
  readonly dismissedResetCreditKeys?: readonly string[];
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

  const windowDurationMs = next.windowDurationMs ?? previous.windowDurationMs;
  const nextCycleHasStarted =
    next.resetAt !== null &&
    windowDurationMs !== null &&
    windowDurationMs !== undefined &&
    Number.isFinite(windowDurationMs) &&
    Number.isFinite(reportedAtMs) &&
    reportedAtMs >= next.resetAt - windowDurationMs - CODEX_RESET_TIME_JITTER_MS;

  // Ignore a transient zero unless the provider advances the reset timestamp
  // to a cycle that has really begun. Ordinarily that means the old cycle
  // elapsed. OpenAI can also grant an out-of-band reset, which starts a new
  // full-duration window immediately while the old reset was still in the
  // future; its reported reset minus duration proves that new cycle has begun.
  return nextCycleIsLater && (previousCycleElapsed || nextCycleHasStarted) ? next : previous;
}

export function providerUsageResetCreditKey(credit: PersistedProviderUsageResetCredit): string {
  if (credit.id) return `id:${credit.id}`;
  return `anonymous:${JSON.stringify([credit.title, credit.description, credit.expiresAt])}`;
}

function mergeResetCredits(
  previous: PersistedProviderUsageResetCredits | null | undefined,
  next: PersistedProviderUsageResetCredits | null | undefined,
  dismissedKeys: ReadonlySet<string>,
): PersistedProviderUsageResetCredits | null {
  if (!previous && !next) return null;
  const creditsByKey = new Map<string, PersistedProviderUsageResetCredit>();
  for (const credit of previous?.credits ?? []) {
    creditsByKey.set(providerUsageResetCreditKey(credit), credit);
  }
  for (const credit of next?.credits ?? []) {
    creditsByKey.set(providerUsageResetCreditKey(credit), credit);
  }

  const credits = Array.from(creditsByKey.entries()).flatMap(([key, credit]) =>
    dismissedKeys.has(key) ? [] : [credit],
  );
  const reportedAvailableCount = Math.max(previous?.availableCount ?? 0, next?.availableCount ?? 0);
  let dismissedReportedCount = 0;
  for (const [key, credit] of creditsByKey) {
    if (!dismissedKeys.has(key)) continue;
    // A count-only row represents the complete anonymous inventory. Once the
    // user acts on it, an incomplete refresh must not recreate it.
    dismissedReportedCount += credit.id === null ? reportedAvailableCount : 1;
  }
  const availableCount = Math.max(credits.length, reportedAvailableCount - dismissedReportedCount);
  return availableCount > 0 && credits.length > 0 ? { availableCount, credits } : null;
}

interface ProviderUsageState {
  readonly byAccountKey: Readonly<Record<string, PersistedProviderUsageEntry>>;
  record: (entry: PersistedProviderUsageEntry) => void;
  dismissResetCredit: (accountKey: string, credit: PersistedProviderUsageResetCredit) => void;
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
  const dismissedResetCreditKeys = Array.from(
    new Set([
      ...(previous?.dismissedResetCreditKeys ?? []),
      ...(entry.dismissedResetCreditKeys ?? []),
    ]),
  );
  const resetCredits = mergeResetCredits(
    previous?.resetCredits,
    entry.resetCredits,
    new Set(dismissedResetCreditKeys),
  );
  const merged = {
    ...entry,
    windows: Array.from(windowsByKey.values()),
    resetCredits,
    dismissedResetCreditKeys,
    reportedAt:
      previous && previous.reportedAt > entry.reportedAt ? previous.reportedAt : entry.reportedAt,
  };
  if (previous && JSON.stringify(previous) === JSON.stringify(merged)) return state;
  return { ...state, [entry.accountKey]: merged };
}

export function dismissProviderUsageResetCredit(
  state: Readonly<Record<string, PersistedProviderUsageEntry>>,
  accountKey: string,
  credit: PersistedProviderUsageResetCredit,
): Readonly<Record<string, PersistedProviderUsageEntry>> {
  const previous = state[accountKey];
  if (!previous) return state;
  const creditKey = providerUsageResetCreditKey(credit);
  if (previous.dismissedResetCreditKeys?.includes(creditKey)) return state;
  const dismissedResetCreditKeys = [...(previous.dismissedResetCreditKeys ?? []), creditKey];
  const resetCredits = mergeResetCredits(
    previous.resetCredits,
    null,
    new Set(dismissedResetCreditKeys),
  );
  return {
    ...state,
    [accountKey]: {
      ...previous,
      resetCredits,
      dismissedResetCreditKeys,
    },
  };
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

function isPersistedResetCredit(value: unknown): value is PersistedProviderUsageResetCredit {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<PersistedProviderUsageResetCredit>;
  return (
    (candidate.id === null || typeof candidate.id === "string") &&
    typeof candidate.title === "string" &&
    candidate.title.length > 0 &&
    (candidate.description === null || typeof candidate.description === "string") &&
    (candidate.expiresAt === null ||
      (typeof candidate.expiresAt === "number" &&
        Number.isFinite(candidate.expiresAt) &&
        candidate.expiresAt > 0))
  );
}

function isPersistedResetCredits(value: unknown): value is PersistedProviderUsageResetCredits {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<PersistedProviderUsageResetCredits>;
  return (
    typeof candidate.availableCount === "number" &&
    Number.isSafeInteger(candidate.availableCount) &&
    candidate.availableCount > 0 &&
    Array.isArray(candidate.credits) &&
    candidate.credits.length > 0 &&
    candidate.credits.every(isPersistedResetCredit)
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
          Number.isFinite(Date.parse(candidate.reportedAt)) &&
          (candidate.resetCredits === undefined ||
            candidate.resetCredits === null ||
            isPersistedResetCredits(candidate.resetCredits)) &&
          (candidate.dismissedResetCreditKeys === undefined ||
            (Array.isArray(candidate.dismissedResetCreditKeys) &&
              candidate.dismissedResetCreditKeys.every(
                (key) => typeof key === "string" && key.length > 0,
              )))
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
  dismissResetCredit: (accountKey, credit) =>
    set((state) => {
      const byAccountKey = dismissProviderUsageResetCredit(state.byAccountKey, accountKey, credit);
      if (byAccountKey === state.byAccountKey) return state;
      persistEntries(byAccountKey);
      return { byAccountKey };
    }),
}));

export function resetProviderUsageStoreForTests(): void {
  useProviderUsageStore.setState({ byAccountKey: {} });
}
