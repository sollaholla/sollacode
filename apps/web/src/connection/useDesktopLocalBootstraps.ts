import type { DesktopEnvironmentBootstrap } from "@t3tools/contracts";
import { useEffect, useState } from "react";

import { readDesktopSecondaryBootstraps } from "./desktopLocal";

const DESKTOP_LOCAL_BOOTSTRAP_POLL_MS = 2_000;

/**
 * Reactively track the desktop's secondary local backends (e.g. a parallel WSL
 * backend). The bridge exposes no change event, so we re-read on an interval;
 * failed reads retain the latest successful snapshot, while a successful empty
 * read clears it. Use this instead of polling the bridge ad hoc so every
 * renderer consumer reads the same topology.
 */
export function useDesktopLocalBootstraps(): ReadonlyArray<DesktopEnvironmentBootstrap> {
  const [bootstraps, setBootstraps] = useState<ReadonlyArray<DesktopEnvironmentBootstrap>>(
    readDesktopSecondaryBootstraps,
  );

  useEffect(() => {
    // Each read returns a fresh array; keeping the previous one while the
    // topology is unchanged spares consumers a re-render on every poll.
    const read = () => {
      const next = readDesktopSecondaryBootstraps();
      setBootstraps((previous) => (sameBootstraps(previous, next) ? previous : next));
    };
    read();
    const interval = setInterval(read, DESKTOP_LOCAL_BOOTSTRAP_POLL_MS);
    return () => clearInterval(interval);
  }, []);

  return bootstraps;
}

function sameBootstraps(
  previous: ReadonlyArray<DesktopEnvironmentBootstrap>,
  next: ReadonlyArray<DesktopEnvironmentBootstrap>,
): boolean {
  return (
    previous.length === next.length &&
    previous.every((entry, index) => {
      const other = next[index]!;
      return (
        entry.id === other.id &&
        entry.label === other.label &&
        entry.runningDistro === other.runningDistro &&
        entry.httpBaseUrl === other.httpBaseUrl &&
        entry.wsBaseUrl === other.wsBaseUrl &&
        entry.bootstrapToken === other.bootstrapToken
      );
    })
  );
}
