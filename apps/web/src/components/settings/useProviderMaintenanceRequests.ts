import type { ProviderDriverKind } from "@t3tools/contracts";
import { useCallback, useRef, useState } from "react";

/** Own the request lock synchronously; React state only mirrors it for the buttons. */
export function useProviderMaintenanceRequests() {
  const inFlight = useRef(new Set<ProviderDriverKind>());
  const [pendingDrivers, setPendingDrivers] = useState<ReadonlySet<ProviderDriverKind>>(
    () => new Set(),
  );
  const run = useCallback(async (driver: ProviderDriverKind, request: () => Promise<void>) => {
    if (inFlight.current.has(driver)) return;
    inFlight.current.add(driver);
    setPendingDrivers(new Set(inFlight.current));
    try {
      await request();
    } finally {
      inFlight.current.delete(driver);
      setPendingDrivers(new Set(inFlight.current));
    }
  }, []);
  return { pendingDrivers, run };
}
