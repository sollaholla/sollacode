import { createContext, useContext, type ReactNode } from "react";

import { useOrchestratorSession, type OrchestratorSessionApi } from "./useOrchestratorSession";

/**
 * Hosts the one voice session, above the sidebars.
 *
 * The pinned entry that starts a session lives in both `SidebarV2` and the v1
 * `Sidebar`, and the app swaps between them (v1 is what renders on `/settings*`).
 * Owning the session inside either one would tear the microphone down whenever
 * the user opened settings, so it is owned here and consumed by both.
 */
const OrchestratorSessionContext = createContext<OrchestratorSessionApi | null>(null);

export function OrchestratorSessionProvider({ children }: { children: ReactNode }) {
  const session = useOrchestratorSession();
  return (
    <OrchestratorSessionContext.Provider value={session}>
      {children}
    </OrchestratorSessionContext.Provider>
  );
}

/** Returns null outside the provider (e.g. isolated component tests). */
export function useOrchestratorSessionContext(): OrchestratorSessionApi | null {
  return useContext(OrchestratorSessionContext);
}
