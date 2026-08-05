export function sideChatDisplayTitle(title: string): string {
  return title.replace(/ \(side chat\)$/i, "");
}

interface SideChatActivityThread {
  readonly id: string;
  readonly environmentId: string;
  readonly isSideChat?: boolean;
  readonly sideChatParentThreadId?: string | null;
  readonly archivedAt: string | null;
  readonly updatedAt: string;
  readonly latestTurn: {
    readonly requestedAt: string;
    readonly startedAt: string | null;
  } | null;
  readonly session: {
    readonly status: string;
    readonly updatedAt: string;
  } | null;
}

export interface WorkingSideChatActivity {
  readonly count: number;
  readonly threadIds: readonly string[];
  readonly startedAt: string | null;
}

export function sideChatParentActivityKey(environmentId: string, parentThreadId: string): string {
  return `${environmentId}:${parentThreadId}`;
}

export function isSideChatActivelyWorking(thread: SideChatActivityThread): boolean {
  return thread.session?.status === "starting" || thread.session?.status === "running";
}

function firstValidIso(...candidates: ReadonlyArray<string | null | undefined>): string | null {
  for (const candidate of candidates) {
    if (candidate !== null && candidate !== undefined && !Number.isNaN(Date.parse(candidate))) {
      return candidate;
    }
  }
  return null;
}

/**
 * Aggregates live child work by durable parent identity. Promoted side chats
 * disappear automatically because promotion clears their side-chat relation.
 */
export function deriveWorkingSideChatsByParent(
  threads: ReadonlyArray<SideChatActivityThread>,
  pendingStartedAtByThreadKey: Readonly<Record<string, string>> = {},
): ReadonlyMap<string, WorkingSideChatActivity> {
  const mutable = new Map<
    string,
    { count: number; threadIds: string[]; startedAt: string | null }
  >();
  for (const thread of threads) {
    const parentThreadId = thread.sideChatParentThreadId;
    const pendingStartedAt =
      pendingStartedAtByThreadKey[sideChatParentActivityKey(thread.environmentId, thread.id)] ??
      null;
    if (
      thread.isSideChat !== true ||
      parentThreadId === null ||
      parentThreadId === undefined ||
      thread.archivedAt !== null ||
      (!isSideChatActivelyWorking(thread) && pendingStartedAt === null)
    ) {
      continue;
    }
    const key = sideChatParentActivityKey(thread.environmentId, parentThreadId);
    const runtimeStartedAt = firstValidIso(
      thread.latestTurn?.startedAt,
      thread.latestTurn?.requestedAt,
      thread.session?.updatedAt,
      thread.updatedAt,
    );
    const startedAt =
      [runtimeStartedAt, pendingStartedAt]
        .filter((value): value is string => value !== null && !Number.isNaN(Date.parse(value)))
        .toSorted((left, right) => Date.parse(left) - Date.parse(right))[0] ?? null;
    const existing = mutable.get(key);
    if (!existing) {
      mutable.set(key, { count: 1, threadIds: [thread.id], startedAt });
      continue;
    }
    existing.count += 1;
    existing.threadIds.push(thread.id);
    if (
      startedAt !== null &&
      (existing.startedAt === null || Date.parse(startedAt) < Date.parse(existing.startedAt))
    ) {
      existing.startedAt = startedAt;
    }
  }
  return mutable;
}
