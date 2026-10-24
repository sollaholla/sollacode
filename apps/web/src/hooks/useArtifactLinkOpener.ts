import { useRouter } from "@tanstack/react-router";
import { resolveThreadArtifactLink } from "@t3tools/client-runtime/preview/link-routing";
import type { EnvironmentId } from "@t3tools/contracts";
import { useCallback } from "react";
import { environmentCatalog } from "../connection/catalog";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { useRightPanelStore } from "../rightPanelStore";
import { stackedThreadToast, toastManager } from "../components/ui/toast";

/** Open artifact routes in the current app; the route owns loading their preview. */
export function useArtifactLinkOpener(contextEnvironmentId: EnvironmentId | null) {
  const router = useRouter({ warn: false });
  const resolveArtifactLink = useCallback(
    (href: string) => {
      const known = new Set(
        appAtomRegistry.get(environmentCatalog.catalogValueAtom).entries.keys(),
      );
      if (contextEnvironmentId) known.add(contextEnvironmentId);
      return resolveThreadArtifactLink(href, known);
    },
    [contextEnvironmentId],
  );
  const openArtifactLink = useCallback(
    (href: string) => {
      const target = resolveArtifactLink(href);
      if (!target || !router) return false;
      const { artifactId, ...threadRef } = target;
      // Re-focus an existing preview even if the URL already selects this artifact.
      useRightPanelStore.getState().activateSurface(threadRef, `artifact:${artifactId}`);
      void router
        .navigate({
          to: "/$environmentId/$threadId",
          params: threadRef,
          search: { artifact: artifactId },
        })
        .catch((cause: unknown) => {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Unable to open artifact",
              description:
                cause instanceof Error ? cause.message : "The artifact could not be opened.",
            }),
          );
        });
      return true;
    },
    [resolveArtifactLink, router],
  );
  return { resolveArtifactLink, openArtifactLink };
}
