import {
  localDayKey,
  pruneUsage,
  recordUsage,
  type RealtimeUsage,
  type UsageDay,
} from "./usageTracking";

/**
 * Where the usage history lives.
 *
 * Deliberately local storage rather than server settings: this is an
 * append-mostly log that grows every session, and settings.json is neither
 * shaped for that nor safe to rewrite on every response. It is also genuinely
 * per-machine — the spend recorded here is what *this* client sent — and
 * losing it costs a history table, not any behaviour.
 *
 * Only daily-per-model aggregates are stored, so a year of heavy use is a few
 * hundred small rows.
 */

const STORAGE_KEY = "solla.orchestrator.usage.v1";

function readStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    // Storage can be unavailable (privacy mode, embedded contexts). Usage
    // tracking is presentation; it must never take the voice session with it.
    return null;
  }
}

export function loadUsageDays(): ReadonlyArray<UsageDay> {
  const storage = readStorage();
  if (storage === null) return [];
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isUsageDay);
  } catch {
    return [];
  }
}

function isUsageDay(value: unknown): value is UsageDay {
  if (typeof value !== "object" || value === null) return false;
  const day = value as Record<string, unknown>;
  return (
    typeof day.date === "string" &&
    typeof day.model === "string" &&
    typeof day.sessions === "number" &&
    typeof day.usage === "object" &&
    day.usage !== null
  );
}

function saveUsageDays(days: ReadonlyArray<UsageDay>): void {
  const storage = readStorage();
  if (storage === null) return;
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(days));
  } catch {
    // A full quota must not break the session either.
  }
}

/** Folds one response's usage in and persists. Returns the new history. */
export function appendUsage(input: {
  readonly model: string;
  readonly usage: RealtimeUsage;
  readonly now: Date;
}): ReadonlyArray<UsageDay> {
  const existing = loadUsageDays();
  const next = pruneUsage(
    recordUsage(existing, {
      date: localDayKey(input.now),
      model: input.model,
      usage: input.usage,
    }),
    input.now,
  );
  saveUsageDays(next);
  return next;
}

export function clearUsage(): void {
  const storage = readStorage();
  if (storage === null) return;
  try {
    storage.removeItem(STORAGE_KEY);
  } catch {
    // Nothing to do; the caller re-reads and sees whatever survived.
  }
}
