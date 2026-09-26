import { create } from "zustand";
import * as Predicate from "effect/Predicate";

export interface LiveVoiceUsage {
  readonly sessionId: string;
  readonly seconds: number;
  readonly finalized: boolean;
}
interface LiveUsageEntry extends LiveVoiceUsage {
  readonly date: string;
}
const STORAGE_KEY = "solla.orchestrator.live-usage.v1";

/** Usage events are cumulative snapshots; retries and final receipts never add twice. */
export function mergeLiveVoiceUsage(
  entries: readonly LiveUsageEntry[],
  sample: LiveVoiceUsage,
  now = new Date(),
): readonly LiveUsageEntry[] {
  if (!Number.isFinite(sample.seconds) || sample.seconds < 0 || !sample.sessionId) return entries;
  const previous = entries.find((entry) => entry.sessionId === sample.sessionId);
  const next = {
    ...sample,
    seconds: Math.max(previous?.seconds ?? 0, sample.seconds),
    finalized: previous?.finalized === true || sample.finalized,
    date: previous?.date ?? now.toISOString(),
  };
  const cutoff = now.getTime() - 180 * 24 * 60 * 60_000;
  return [
    ...entries.filter(
      (entry) => entry.sessionId !== sample.sessionId && Date.parse(entry.date) >= cutoff,
    ),
    next,
  ].slice(-500);
}
function load(): readonly LiveUsageEntry[] {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
    if (!Array.isArray(raw)) return [];
    return raw
      .filter(
        (entry): entry is LiveUsageEntry =>
          Predicate.isObject(entry) &&
          typeof entry.sessionId === "string" &&
          typeof entry.seconds === "number" &&
          Number.isFinite(entry.seconds) &&
          entry.seconds >= 0 &&
          typeof entry.finalized === "boolean" &&
          typeof entry.date === "string" &&
          Number.isFinite(Date.parse(entry.date)),
      )
      .slice(-500);
  } catch {
    return [];
  }
}
function save(entries: readonly LiveUsageEntry[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  } catch {
    /* Usage storage must not interrupt speech. */
  }
}

export const useLiveUsageStore = create<{
  entries: readonly LiveUsageEntry[];
  record: (sample: LiveVoiceUsage) => void;
  clear: () => void;
}>((set) => ({
  entries: load(),
  record: (sample) =>
    set((state) => {
      const entries = mergeLiveVoiceUsage(state.entries, sample);
      save(entries);
      return { entries };
    }),
  clear: () => {
    save([]);
    set({ entries: [] });
  },
}));
