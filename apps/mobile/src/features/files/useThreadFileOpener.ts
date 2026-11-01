import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { resolveAssetUrl } from "@t3tools/client-runtime/state/assets";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { Linking } from "react-native";

import { assetEnvironment } from "../../state/assets";
import { usePreparedConnection } from "../../state/session";
import { useAtomQueryRunner } from "../../state/use-atom-query-runner";

const FAILURE_DISMISS_MS = 6_000;

/**
 * Open a file outside the thread's workspace in the system browser, through a
 * short-lived link the thread's host signs because a message in the thread names it.
 * `failure` is what to show when it can't, for the caller to render in place.
 */
export function useThreadFileOpener(environmentId: EnvironmentId, threadId: ThreadId) {
  const preparedConnection = usePreparedConnection(environmentId);
  const createAssetUrl = useAtomQueryRunner(assetEnvironment.createUrl, { reportFailure: false });
  const [failure, setFailure] = useState<string | null>(null);
  const dismissTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dismissFailure = useCallback(() => {
    if (dismissTimer.current) clearTimeout(dismissTimer.current);
    dismissTimer.current = null;
    setFailure(null);
  }, []);
  useEffect(() => dismissFailure, [dismissFailure]);
  const openFile = useCallback(
    (filePath: string) => {
      dismissFailure();
      void (async () => {
        try {
          if (preparedConnection._tag === "None") {
            throw new Error("This computer isn't connected.");
          }
          const result = await createAssetUrl({
            environmentId,
            input: { resource: { _tag: "thread-file", threadId, path: filePath } },
          });
          if (result._tag === "Failure") {
            if (isAtomCommandInterrupted(result)) return;
            throw squashAtomCommandFailure(result);
          }
          const url = resolveAssetUrl(
            preparedConnection.value.httpBaseUrl,
            result.value.relativeUrl,
          );
          if (url === null) throw new Error("The computer returned an unusable file link.");
          await Linking.openURL(url);
        } catch (cause) {
          setFailure(cause instanceof Error ? cause.message : "Unable to open that file.");
          dismissTimer.current = setTimeout(dismissFailure, FAILURE_DISMISS_MS);
        }
      })();
    },
    [createAssetUrl, dismissFailure, environmentId, preparedConnection, threadId],
  );
  return { openFile, failure, dismissFailure };
}
