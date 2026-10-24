import { useCallback, useEffect, useMemo, useRef } from "react";

export interface LowContextWarningAction {
  readonly onCompactAndContinue: () => void;
  readonly busy: boolean;
}

/**
 * The low-context action, pinned to what actually changes its look: whether it
 * exists and whether it is busy.
 *
 * The timeline builds `{ onCompactAndContinue, busy }` fresh on every render of
 * a finished message, and the callback inside is recreated whenever the active
 * thread updates (it closes over the thread, `isWorking` and the activity
 * count). Both feed ChatMarkdown's components map, so each update while an
 * agent worked gave every finished message a new map, and react-markdown
 * remounted all of its links and icons -- they flashed continuously. The
 * latest callback is kept in a ref and called through one stable wrapper, so
 * a click always runs the current one and nothing else depends on its identity.
 */
export function useStableLowContextWarningAction(
  action: LowContextWarningAction | undefined,
): LowContextWarningAction | undefined {
  const latest = useRef(action?.onCompactAndContinue);
  const onCompactAndContinue = action?.onCompactAndContinue;
  useEffect(() => {
    latest.current = onCompactAndContinue;
  }, [onCompactAndContinue]);
  const invoke = useCallback(() => latest.current?.(), []);
  const present = action !== undefined;
  const busy = action?.busy ?? false;
  return useMemo(
    () => (present ? { onCompactAndContinue: invoke, busy } : undefined),
    [busy, invoke, present],
  );
}
