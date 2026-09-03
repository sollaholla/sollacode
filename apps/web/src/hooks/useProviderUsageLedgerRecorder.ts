import type { OrchestrationThreadActivity } from "@t3tools/contracts";
import { useEffect } from "react";

import { useProviderUsageLedgerStore } from "../providerUsageLedgerStore";

/**
 * Fold the visible thread's activities into the per-provider usage ledger.
 * Recording is idempotent per turn, so re-renders and re-opened threads never
 * double count.
 */
export function useProviderUsageLedgerRecorder(
  driver: string | null | undefined,
  activities: ReadonlyArray<OrchestrationThreadActivity> | undefined,
): void {
  const recordActivities = useProviderUsageLedgerStore((state) => state.recordActivities);
  useEffect(() => {
    if (!driver || !activities || activities.length === 0) return;
    recordActivities(driver, activities);
  }, [activities, driver, recordActivities]);
}
