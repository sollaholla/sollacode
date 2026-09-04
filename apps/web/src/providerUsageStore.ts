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
  /**
   * When the provider last included this window in a usage response. Windows
   * for experimental models come and go; one the provider has stopped
   * reporting is pruned after `PROVIDER_USAGE_WINDOW_STALE_AFTER_MS`.
   */
  readonly lastSeenAt?: string;
}

export const PROVIDER_USAGE_WINDOW_STALE_AFTER_MS = 7 * 24 * 60 * 60_000;

/**
 * Drop windows the provider has not mentioned for a week. `seenKeys` are the
 * windows in the response being merged, which always survive.
 */
export function pruneStaleUsageWindows(
  windows: ReadonlyArray<PersistedProviderUsageWindow>,
  seenKeys: ReadonlySet<string>,
  nowIso: string,
  fallbackSeenAt: string | undefined,
): PersistedProviderUsageWindow[] {
  const nowMs = Date.parse(nowIso);
  if (!Number.isFinite(nowMs)) return [...windows];
  return windows.filter((window) => {
    if (seenKeys.has(window.key)) return true;
    const seenAt = window.lastSeenAt ?? fallbackSeenAt;
    const seenMs = seenAt === undefined ? Number.NaN : Date.parse(seenAt);
    if (!Number.isFinite(seenMs)) return false;
    return nowMs - seenMs <= PROVIDER_USAGE_WINDOW_STALE_AFTER_MS;
  });
}

export interface PersistedProviderUsageResetCredit {
  readonly id: string | null;
  readonly title: string;
  readonly description: string | null;
  readonly expiresAt: number | null;
  /**
   * When the provider last reported this credit. Mirrors the field usage
   * windows carry: it is what lets an absence be tolerated briefly and then
   * believed, rather than tolerated forever.
   */
  readonly lastSeenAt?: string;
}

/**
 * How long a reset credit survives the provider no longer reporting it.
 *
 * The hysteresis exists because the two Codex endpoints desync: a refresh can
 * omit a credit that is genuinely still there, and without a grace the row
 * flickered on and off. Long enough to ride out that desync, short enough that
 * a credit the user has actually spent disappears while they are still looking
 * at the panel - and, critically, bounded, so two clients that saw different
 * snapshots converge instead of each keeping its own high-water mark forever.
 */
export const PROVIDER_USAGE_RESET_CREDIT_GRACE_MS = 2 * 60_000;

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

export function mergeResetCredits(
  previous: PersistedProviderUsageResetCredits | null | undefined,
  next: PersistedProviderUsageResetCredits | null | undefined,
  dismissedKeys: ReadonlySet<string>,
  reportedAt: string,
): PersistedProviderUsageResetCredits | null {
  // `undefined` means this refresh carried no reset information at all, so
  // nothing was learned and nothing changes. `null` means the provider was
  // asked and answered "none" - that IS news, and has to be able to clear a
  // credit that is gone.
  if (next === undefined) return previous ?? null;
  if (!previous && !next) return null;

  const nowMs = Date.parse(reportedAt);
  const nextByKey = new Map<string, PersistedProviderUsageResetCredit>();
  for (const credit of next?.credits ?? []) {
    nextByKey.set(providerUsageResetCreditKey(credit), { ...credit, lastSeenAt: reportedAt });
  }

  // Returns the credit to carry forward, or null to retire it. Retaining a
  // credit and dating it are the same decision, so they are made together.
  const carryForward = (
    key: string,
    credit: PersistedProviderUsageResetCredit,
  ): PersistedProviderUsageResetCredit | null => {
    if (nextByKey.has(key)) return credit;
    // An expired credit is gone whatever the grace says; the provider will
    // never mention it again and there is nothing to ride out.
    if (credit.expiresAt !== null && Number.isFinite(nowMs) && credit.expiresAt <= nowMs) {
      return null;
    }
    if (!Number.isFinite(nowMs)) return null;
    if (credit.lastSeenAt === undefined) {
      // Written by a build that did not date its credits. Dropping it here
      // would make a real credit blink out on the first desynced refresh after
      // an upgrade - the exact flicker this grace exists to absorb. Adopt it
      // instead: start its clock now so it gets one full grace window and then
      // ages out like any other.
      return { ...credit, lastSeenAt: reportedAt };
    }
    const seenMs = Date.parse(credit.lastSeenAt);
    // An unreadable stamp cannot be aged out, so believe the provider now.
    if (!Number.isFinite(seenMs)) return null;
    return nowMs - seenMs <= PROVIDER_USAGE_RESET_CREDIT_GRACE_MS ? credit : null;
  };

  const creditsByKey = new Map<string, PersistedProviderUsageResetCredit>();
  for (const credit of previous?.credits ?? []) {
    const key = providerUsageResetCreditKey(credit);
    const carried = carryForward(key, credit);
    if (carried !== null) creditsByKey.set(key, carried);
  }
  for (const [key, credit] of nextByKey) creditsByKey.set(key, credit);

  const credits = Array.from(creditsByKey.entries()).flatMap(([key, credit]) =>
    dismissedKeys.has(key) ? [] : [credit],
  );

  // How many credits a row stands for. An id'd row is one; a count-only row is
  // the whole anonymous inventory, so it is worth whatever count it arrived
  // with - the new report's if the provider just sent it, the old one's if we
  // are holding it through a desync. Reading the new count off a row we
  // retained from the old report is what made the total lurch mid-grace.
  const weightOf = (key: string, credit: PersistedProviderUsageResetCredit): number => {
    if (credit.id !== null) return 1;
    return nextByKey.has(key) ? (next?.availableCount ?? 0) : (previous?.availableCount ?? 1);
  };

  // Summed per surviving row rather than carried as a running maximum. Maxing
  // across refreshes let the number only ever climb, so a spent reset stayed on
  // screen and two clients that peaked differently never agreed on it again.
  let knownAvailableCount = 0;
  for (const [key, credit] of creditsByKey) {
    // Once the user acts on a row, an incomplete refresh must not recreate it.
    if (dismissedKeys.has(key)) continue;
    knownAvailableCount += weightOf(key, credit);
  }
  const availableCount = Math.max(credits.length, knownAvailableCount);
  return availableCount > 0 && credits.length > 0 ? { availableCount, credits } : null;
}

/**
 * Drop credits whose expiry has passed.
 *
 * The merge prunes them whenever a report lands, but a client that is idle (or
 * offline) between reports would otherwise keep offering a reset that expired
 * while it was sitting there.
 */
export function activeResetCredits(
  resetCredits: PersistedProviderUsageResetCredits | null | undefined,
  nowMs: number,
): PersistedProviderUsageResetCredits | null {
  if (!resetCredits) return null;
  const credits = resetCredits.credits.filter(
    (credit) => credit.expiresAt === null || credit.expiresAt > nowMs,
  );
  if (credits.length === resetCredits.credits.length) return resetCredits;
  const availableCount = Math.min(resetCredits.availableCount, credits.length);
  return availableCount > 0 && credits.length > 0 ? { availableCount, credits } : null;
}

function withoutDismissedResetCredits(
  resetCredits: PersistedProviderUsageResetCredits | null | undefined,
  dismissedKeys: ReadonlySet<string>,
): PersistedProviderUsageResetCredits | null {
  if (!resetCredits) return null;
  const credits = resetCredits.credits.filter(
    (credit) => !dismissedKeys.has(providerUsageResetCreditKey(credit)),
  );
  let dismissedReportedCount = 0;
  for (const credit of resetCredits.credits) {
    if (!dismissedKeys.has(providerUsageResetCreditKey(credit))) continue;
    dismissedReportedCount += credit.id === null ? resetCredits.availableCount : 1;
  }
  const availableCount = Math.max(
    credits.length,
    resetCredits.availableCount - dismissedReportedCount,
  );
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
  const seenKeys = new Set<string>();
  for (const window of entry.windows) {
    seenKeys.add(window.key);
    if (!entryIsOlder || !windowsByKey.has(window.key)) {
      windowsByKey.set(window.key, {
        ...mergeUsageWindow(entry.driver, windowsByKey.get(window.key), window, entry.reportedAt),
        lastSeenAt: entry.reportedAt,
      });
    }
  }
  const survivingWindows = entryIsOlder
    ? Array.from(windowsByKey.values())
    : pruneStaleUsageWindows(
        Array.from(windowsByKey.values()),
        seenKeys,
        entry.reportedAt,
        previous?.reportedAt,
      );
  const dismissedResetCreditKeys = Array.from(
    new Set([
      ...(previous?.dismissedResetCreditKeys ?? []),
      ...(entry.dismissedResetCreditKeys ?? []),
    ]),
  );
  const resetCredits = entryIsOlder
    ? // A late-arriving older report must not decide what is current; it can
      // still only lose to what we already know.
      withoutDismissedResetCredits(previous.resetCredits, new Set(dismissedResetCreditKeys))
    : mergeResetCredits(
        previous?.resetCredits,
        entry.resetCredits,
        new Set(dismissedResetCreditKeys),
        entry.reportedAt,
      );
  const merged = {
    ...entry,
    windows: survivingWindows,
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
  // Dismissal is a local edit, not a provider report: it must not age credits
  // out or restamp them as freshly seen, only drop the one the user acted on.
  const resetCredits = withoutDismissedResetCredits(
    previous.resetCredits,
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
        candidate.expiresAt > 0)) &&
    (candidate.lastSeenAt === undefined || typeof candidate.lastSeenAt === "string")
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
