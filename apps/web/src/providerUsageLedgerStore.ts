import type { OrchestrationThreadActivity } from "@t3tools/contracts";
import { create } from "zustand";
import { persist } from "zustand/middleware";

import {
  EMPTY_PROVIDER_USAGE_LEDGER,
  recordActivitiesIntoLedger,
  type ProviderUsageLedger,
} from "./providerUsageLedger";

export const PROVIDER_USAGE_LEDGER_STORAGE_KEY = "solla:provider-usage-ledger:v1";

interface ProviderUsageLedgerStoreState {
  readonly ledger: ProviderUsageLedger;
  readonly recordActivities: (
    driver: string,
    activities: ReadonlyArray<OrchestrationThreadActivity>,
  ) => void;
  readonly clearDriver: (driver: string) => void;
}

/**
 * What this device has seen each provider spend, thread by thread. Not an
 * account total — only threads opened here contribute — but exact for those.
 */
export const useProviderUsageLedgerStore = create<ProviderUsageLedgerStoreState>()(
  persist(
    (set, get) => ({
      ledger: EMPTY_PROVIDER_USAGE_LEDGER,
      recordActivities: (driver, activities) => {
        const next = recordActivitiesIntoLedger(get().ledger, driver, activities);
        if (next !== get().ledger) {
          set({ ledger: next });
        }
      },
      clearDriver: (driver) => {
        const turns = Object.fromEntries(
          Object.entries(get().ledger.turns).filter(([, turn]) => turn.driver !== driver),
        );
        set({ ledger: { version: 1, turns } });
      },
    }),
    {
      name: PROVIDER_USAGE_LEDGER_STORAGE_KEY,
      partialize: (state) => ({ ledger: state.ledger }),
    },
  ),
);
