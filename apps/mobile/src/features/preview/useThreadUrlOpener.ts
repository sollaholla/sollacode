import { useNavigation, type NavigationProp } from "@react-navigation/native";
import {
  openThreadUrl,
  resolveThreadArtifactLink,
} from "@t3tools/client-runtime/preview/link-routing";
import { RegistryContext } from "@effect/atom-react";
import { environmentCatalog } from "../../connection/catalog";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useCallback, useContext, type ComponentProps } from "react";
import { Alert, Linking } from "react-native";
import { previewEnvironment } from "../../state/preview";
import { useAtomCommand } from "../../state/use-atom-command";
import type { ThreadArtifactRouteScreen } from "../artifacts/ThreadArtifactRouteScreens";
import type { ThreadBrowserRouteScreen } from "./ThreadBrowserRouteScreen";

type LinkRoutes = {
  ThreadArtifact: ComponentProps<typeof ThreadArtifactRouteScreen>["route"]["params"];
  ThreadBrowser: ComponentProps<typeof ThreadBrowserRouteScreen>["route"]["params"];
};

/** Open private web links on the thread's host, then show its returned tab. */
export function useThreadUrlOpener(environmentId: EnvironmentId | null, threadId: ThreadId | null) {
  const navigation = useNavigation<NavigationProp<LinkRoutes>>();
  const registry = useContext(RegistryContext);
  const openPreview = useAtomCommand(previewEnvironment.open, { reportFailure: false });
  return useCallback(
    (url: string) => {
      const known = new Set(registry.get(environmentCatalog.catalogValueAtom).entries.keys());
      if (environmentId) known.add(environmentId);
      const artifact = resolveThreadArtifactLink(url, known);
      if (artifact) {
        navigation.navigate("ThreadArtifact", artifact);
        return;
      }
      void openThreadUrl({
        url,
        isRemoteClient: environmentId !== null && threadId !== null,
        openExternally: (target) => Linking.openURL(target),
        openInPreview: async (target) => {
          if (environmentId === null || threadId === null) return;
          const result = await openPreview({ environmentId, input: { threadId, url: target } });
          if (result._tag === "Failure") {
            if (isAtomCommandInterrupted(result)) return;
            throw squashAtomCommandFailure(result);
          }
          navigation.navigate("ThreadBrowser", {
            environmentId: String(environmentId),
            threadId: String(threadId),
            tabId: result.value.tabId,
          });
        },
      }).catch((cause: unknown) => {
        Alert.alert(
          "Unable to open link",
          cause instanceof Error ? cause.message : "The host preview is unavailable.",
        );
      });
    },
    [environmentId, threadId, openPreview, navigation, registry],
  );
}
