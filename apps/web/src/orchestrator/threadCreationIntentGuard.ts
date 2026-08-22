/**
 * A voice model can repeat the same `create_thread` tool call with a new call
 * id while finishing one response. The transport's call-id guard cannot spot
 * that replay, so keep the side effect single-flight by its actual intent.
 */

export const RECENT_THREAD_CREATION_WINDOW_MS = 15_000;

export interface ThreadCreationIntent {
  readonly environmentId: string;
  readonly projectId: string;
  readonly title: string;
  readonly message: string;
}

interface GuardEntry {
  readonly promise: Promise<void>;
  settledAt: number | null;
}

export interface ThreadCreationIntentGuard {
  readonly run: (intent: ThreadCreationIntent, create: () => Promise<void>) => Promise<void>;
}

function intentKey(intent: ThreadCreationIntent): string {
  return JSON.stringify([intent.environmentId, intent.projectId, intent.title, intent.message]);
}

export function createThreadCreationIntentGuard(
  options: {
    readonly now?: () => number;
    readonly windowMs?: number;
  } = {},
): ThreadCreationIntentGuard {
  const now = options.now ?? Date.now;
  const windowMs = options.windowMs ?? RECENT_THREAD_CREATION_WINDOW_MS;
  const entries = new Map<string, GuardEntry>();

  return {
    run: (intent, create) => {
      const key = intentKey(intent);
      const current = now();

      for (const [candidateKey, candidate] of entries) {
        if (candidate.settledAt !== null && current - candidate.settledAt > windowMs) {
          entries.delete(candidateKey);
        }
      }

      const existing = entries.get(key);
      if (existing !== undefined) return existing.promise;

      let entry!: GuardEntry;
      const promise = Promise.resolve()
        .then(create)
        .then(
          () => {
            entry.settledAt = now();
          },
          (cause: unknown) => {
            // Creation and first-message delivery are two server commands. If
            // the first landed and the second failed, immediately replaying
            // the whole operation would create a duplicate empty thread. Keep
            // failures inside the same short replay window too; a genuinely
            // new request can retry once it expires.
            entry.settledAt = now();
            throw cause;
          },
        );
      entry = { promise, settledAt: null };
      entries.set(key, entry);
      return promise;
    },
  };
}
