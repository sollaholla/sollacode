import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useEffect, useMemo } from "react";

import { useThreadShell } from "~/state/entities";

import {
  browserProfileKey,
  parseBrowserProfileKey,
  resolveBrowserProfile,
} from "../../browser/hostedBrowserProfileBinding";
import { canControlLocalPreviewGuest } from "../../previewStateStore";
import { resolveThreadDownloadDirectory } from "./threadDownloadDirectory";

/**
 * Points this thread's browser downloads at its own workspace.
 *
 * The desktop side only ever sees an opaque partition scope, so it cannot know
 * where a thread is working — the renderer has to tell it. Without this a
 * download lands in the app's artifacts folder, which is fine for a human who
 * can go find it and useless to an agent that wants to run the next command
 * against the file.
 */
export function PreviewDownloadDirectorySync(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly projectId: string | undefined;
  readonly browserProfileThreadId: ThreadId | null | undefined;
  readonly cwd: string | null;
}) {
  const { environmentId, threadId, projectId, browserProfileThreadId, cwd } = props;
  const rootRef = useMemo(
    () => (browserProfileThreadId ? scopeThreadRef(environmentId, browserProfileThreadId) : null),
    [browserProfileThreadId, environmentId],
  );
  const rootShell = useThreadShell(rootRef);
  const profileKey =
    projectId === undefined
      ? undefined
      : browserProfileKey(
          resolveBrowserProfile({
            threadId,
            projectId,
            browserProfileThreadId,
            profileRootProjectId: rootShell?.projectId,
          }),
        );

  useEffect(() => {
    if (!canControlLocalPreviewGuest()) return;
    const directory = resolveThreadDownloadDirectory(cwd);
    // No workspace means no better answer than the desktop's own fallback.
    if (directory === null) return;
    void window.desktopBridge?.preview
      ?.setPreviewDownloadDirectory(
        directory,
        environmentId,
        threadId,
        profileKey ? parseBrowserProfileKey(profileKey) : undefined,
      )
      // Downloads still work via the fallback directory, so a failure here is
      // not worth interrupting anyone over.
      .catch((error: unknown) => {
        console.error("Could not point preview downloads at the workspace.", error);
      });
  }, [environmentId, threadId, profileKey, cwd]);

  return null;
}
