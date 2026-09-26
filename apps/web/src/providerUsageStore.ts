import type { EnvironmentId, ProviderDriverKind, ServerProvider } from "@t3tools/contracts";
import { create } from "zustand";

export const PROVIDER_USAGE_STORAGE_KEY = "solla:provider-usage:v2";
// Battery-saver mode refreshes every 15 minutes. Leave enough scheduling
// headroom that a healthy provider does not flash "Stale" between ticks.
export const PROVIDER_USAGE_STALE_AFTER_MS = 20 * 60_000;

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
  readonly description?: string;
  /**
   * When the provider last included this window in a usage response. Windows
   * for experimental models come and go; one the provider has stopped
   * reporting is pruned after `PROVIDER_USAGE_WINDOW_STALE_AFTER_MS`.
   */
  readonly lastSeenAt?: string;
  /** First unproven lower sample. A second consistent report confirms it. */
  readonly decreaseCandidate?: {
    readonly usedPercent: number;
    readonly resetAt: number | null;
    readonly firstSeenAt: string;
  };
}

export const PROVIDER_USAGE_WINDOW_STALE_AFTER_MS = 7 * 24 * 60 * 60_000;

/**
 * A cold Codex app-server answers with unfilled stand-in windows: 0% used and
 * a reset sitting exactly one window-length after the report itself. The
 * server strips those before publishing (see `codexRateLimitPlaceholders`),
 * but clients persisted some before it did, and a window that was stored as
 * "0% used, resets a week from now" would otherwise sit on the card until a
 * real reading overwrote it. Same tolerance as the server.
 */
export const CODEX_SYNTHETIC_WINDOW_TOLERANCE_MS = 90_000;

export function isSyntheticCodexUsageWindow(
  window: Pick<PersistedProviderUsageWindow, "usedPercent" | "resetAt" | "windowDurationMs">,
  reportedAtMs: number,
): boolean {
  if (window.usedPercent !== 0) return false;
  if (typeof window.resetAt !== "number" || typeof window.windowDurationMs !== "number") {
    return false;
  }
  if (!Number.isFinite(reportedAtMs)) return false;
  return (
    Math.abs(window.resetAt - (reportedAtMs + window.windowDurationMs)) <=
    CODEX_SYNTHETIC_WINDOW_TOLERANCE_MS
  );
}

/** Drop persisted Codex stand-in windows (judged against when they were last seen). */
export function retireSyntheticCodexWindows(
  entries: Readonly<Record<string, PersistedProviderUsageEntry>>,
): Readonly<Record<string, PersistedProviderUsageEntry>> {
  return Object.fromEntries(
    Object.entries(entries).map(([accountKey, entry]) => {
      if (entry.driver !== "codex") return [accountKey, entry];
      const windows = entry.windows.filter(
        (window) =>
          !isSyntheticCodexUsageWindow(window, Date.parse(window.lastSeenAt ?? entry.reportedAt)),
      );
      return [accountKey, windows.length === entry.windows.length ? entry : { ...entry, windows }];
    }),
  );
}

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

function withoutDecreaseCandidate(
  window: PersistedProviderUsageWindow,
): PersistedProviderUsageWindow {
  const { decreaseCandidate: _, ...confirmed } = window;
  return confirmed;
}

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
    next.usedPercent >= previous.usedPercent
  ) {
    return withoutDecreaseCandidate(next);
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

  // A scheduled reset is authoritative as soon as the previous boundary has
  // elapsed. Before that boundary, `resetAt - duration ~= now` is not proof of
  // an out-of-band reset: model-scoped empty buckets use that exact rolling
  // shape and used to make the UI drop to 0%. Early resets are confirmed below
  // only after a second, newer report repeats the same fixed boundary.
  if (nextCycleIsLater && previousCycleElapsed) {
    return withoutDecreaseCandidate(next);
  }

  const candidate = previous.decreaseCandidate;
  const candidateMatchesCycle = candidate?.resetAt === next.resetAt;
  const isNewerConfirmation =
    candidate !== undefined &&
    Number.isFinite(Date.parse(candidate.firstSeenAt)) &&
    Number.isFinite(reportedAtMs) &&
    reportedAtMs > Date.parse(candidate.firstSeenAt);
  const confirmsEarlyReset = nextCycleIsLater && candidateMatchesCycle;
  const confirmsNonZeroCorrection =
    !nextCycleIsLater &&
    next.usedPercent > 0 &&
    candidate !== undefined &&
    next.usedPercent >= candidate.usedPercent;
  if (isNewerConfirmation && (confirmsEarlyReset || confirmsNonZeroCorrection)) {
    return withoutDecreaseCandidate(next);
  }
  return {
    ...previous,
    decreaseCandidate: {
      usedPercent: next.usedPercent,
      resetAt: next.resetAt,
      firstSeenAt: reportedAt,
    },
  };
}

export function providerUsageResetCreditKey(credit: PersistedProviderUsageResetCredit): string {
  if (credit.id) return `id:${credit.id}`;
  return `anonymous:${JSON.stringify([credit.title, credit.description, credit.expiresAt])}`;
}

function mergeResetCredits(
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

  // A response carrying credits is the provider's current expression of the
  // whole inventory, whether it spells it out as detail rows or collapses it
  // into a single count-only row. Believe it outright: the two shapes describe
  // the same credits, so holding the old rows alongside a new one of the other
  // shape counts every credit twice. Retention is for the actual desync
  // signature - a response that came back with nothing at all.
  const nextIsEmpty = nextByKey.size === 0;

  // Returns the credit to carry forward, or null to retire it. Retaining a
  // credit and dating it are the same decision, so they are made together.
  const carryForward = (
    credit: PersistedProviderUsageResetCredit,
  ): PersistedProviderUsageResetCredit | null => {
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
  if (nextIsEmpty) {
    for (const credit of previous?.credits ?? []) {
      const carried = carryForward(credit);
      if (carried !== null) creditsByKey.set(providerUsageResetCreditKey(credit), carried);
    }
  }
  for (const [key, credit] of nextByKey) creditsByKey.set(key, credit);

  const credits = Array.from(creditsByKey.entries()).flatMap(([key, credit]) =>
    dismissedKeys.has(key) ? [] : [credit],
  );

  // How many credits a row stands for. An id'd row is one; a count-only row
  // stands for the whole anonymous inventory, so it is worth the count it
  // arrived with. Every surviving row comes from the same report now, so that
  // count is unambiguous: the provider's when it answered, the one we are
  // holding when it did not.
  const bulkWeight = nextIsEmpty ? (previous?.availableCount ?? 1) : (next?.availableCount ?? 0);
  let retainedTotal = 0;
  let dismissedTotal = 0;
  for (const [key, credit] of creditsByKey) {
    const weight = credit.id === null ? bulkWeight : 1;
    // Once the user acts on a row, an incomplete refresh must not recreate it.
    if (dismissedKeys.has(key)) dismissedTotal += weight;
    else retainedTotal += weight;
  }
  // The provider's own total when it gave one, minus anything already acted on;
  // otherwise the total we are holding through the desync. Never a running
  // maximum - maxing across refreshes let the number only ever climb, so a
  // spent reset stayed on screen and two clients that peaked differently never
  // agreed on it again.
  const reportedTotal = nextIsEmpty ? retainedTotal : (next?.availableCount ?? 0) - dismissedTotal;
  const availableCount = Math.max(credits.length, reportedTotal);
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
 * Uses public account metadata or a server-generated opaque fingerprint.
 * Raw credentials, home paths and cookies are never persisted here.
 */
export function providerUsageAccountKey(
  provider: ServerProvider,
  environmentId?: EnvironmentId,
): string | null {
  // OpenCode's report is held only in the current thread, never persisted as
  // account usage. Free models can report it without an authenticated account.
  if (provider.driver === "opencode") {
    return `${environmentId ?? "local"}\0${provider.instanceId}:session`;
  }
  if (provider.auth.status !== "authenticated") return null;
  let accountKey: string;
  if (provider.accountUsageIdentity) {
    accountKey = `${provider.driver}:instance:${provider.instanceId}:account:${provider.accountUsageIdentity}`;
  } else if (provider.auth.email) {
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
  const entryIsOlder = previous !== undefined && previous.reportedAt > entry.reportedAt;
  // A balance response is a complete currency inventory, not a partial quota
  // update. Removed currencies must disappear immediately on a newer report.
  // Muse's spend report is likewise the whole figure, not one window of many.
  const windowsByKey = new Map(
    (REPLACES_ALL_WINDOWS.has(entry.driver) && !entryIsOlder ? [] : (previous?.windows ?? [])).map(
      (window) => [window.key, window] as const,
    ),
  );
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
    (candidate.detail === undefined || typeof candidate.detail === "string") &&
    (candidate.description === undefined || typeof candidate.description === "string")
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

/** Drivers whose every report is the complete set of windows. */
const REPLACES_ALL_WINDOWS: ReadonlySet<string> = new Set(["deepcode", "muse", "opencode"]);

/**
 * Window keys a driver still reports. Anything else persisted under that
 * driver is a leftover from an earlier build and is dropped on load.
 *
 * Persisted windows are otherwise replaced only by a newer report with the
 * same key, so a driver that stops reporting a window leaves it on screen for
 * a week. That is what a phone showed after 0.1.539: "Session Tokens" and
 * "Context Window" rows from the previous build's Muse report, still on the
 * usage card an hour after the build that retired them had installed, and
 * nothing that would ever remove them short of a fresh report -- which also
 * would not have removed them, since the merge kept unseen keys.
 */
const LIVE_WINDOW_KEYS_BY_DRIVER: Readonly<Record<string, ReadonlySet<string>>> = {
  muse: new Set(["session-spend"]),
  opencode: new Set(["session-cost"]),
};

export function retireUnreportedWindows(
  entries: Readonly<Record<string, PersistedProviderUsageEntry>>,
): Readonly<Record<string, PersistedProviderUsageEntry>> {
  return Object.fromEntries(
    Object.entries(entries).map(([accountKey, entry]) => {
      const live = LIVE_WINDOW_KEYS_BY_DRIVER[entry.driver];
      if (live === undefined) return [accountKey, entry];
      const windows = entry.windows.filter((window) => live.has(window.key));
      return [accountKey, windows.length === entry.windows.length ? entry : { ...entry, windows }];
    }),
  );
}

function parseStoredEntries(): Readonly<Record<string, PersistedProviderUsageEntry>> {
  return retireSyntheticCodexWindows(retireUnreportedWindows(parseStoredEntriesRaw()));
}

function parseStoredEntriesRaw(): Readonly<Record<string, PersistedProviderUsageEntry>> {
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
