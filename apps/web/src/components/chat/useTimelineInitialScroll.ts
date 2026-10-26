import { useState } from "react";

import type { TimelineThreadScrollMemory } from "./timelineScrollAnchoring";

/** Capture the restore destination once per thread visit, before live scroll events update it. */
export function useTimelineInitialScroll(
  memories: ReadonlyMap<string, TimelineThreadScrollMemory>,
  threadKey: string,
): TimelineThreadScrollMemory | null {
  const [snapshot, setSnapshot] = useState(() => ({
    threadKey,
    memory: memories.get(threadKey) ?? null,
  }));
  if (snapshot.threadKey !== threadKey) {
    const nextSnapshot = { threadKey, memory: memories.get(threadKey) ?? null };
    setSnapshot(nextSnapshot);
    return nextSnapshot.memory;
  }
  return snapshot.memory;
}
