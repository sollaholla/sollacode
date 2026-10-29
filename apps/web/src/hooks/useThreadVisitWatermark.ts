import { useEffect, useEffectEvent } from "react";

import { useUiStateStore } from "../uiStateStore";

/** Record visits on open, completion, and wake without subscribing the chat to its own writes. */
export function useThreadVisitWatermark(input: {
  readonly threadKey: string | null;
  readonly updatedAt: string | undefined;
  readonly completedAt: string | null | undefined;
  readonly wokeAt: string | null;
}) {
  const { threadKey, completedAt, wokeAt } = input;
  const recordVisit = useEffectEvent(() => {
    if (input.threadKey === null) return;
    // Timer wakes don't update the thread on the server. A visit still needs
    // to acknowledge that wake even when the last server update is older.
    const timestamps = [input.updatedAt, input.completedAt, input.wokeAt]
      .map((value) => (value ? Date.parse(value) : NaN))
      .filter(Number.isFinite);
    if (timestamps.length === 0) return;
    useUiStateStore
      .getState()
      .markThreadVisited(input.threadKey, new Date(Math.max(...timestamps)).toISOString());
  });

  useEffect(() => {
    recordVisit();
  }, [threadKey, completedAt, wokeAt]);
}
