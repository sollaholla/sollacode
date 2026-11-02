"use client";

import {
  ACCOUNT_PROVIDER_LABELS,
  accountDisplayName,
  accountSignInUrl,
  isUnexpectedSignOut,
} from "@t3tools/client-runtime/preview/account-summary";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, PreviewAccountEvent, ThreadId } from "@t3tools/contracts";
import { useEffect, useEffectEvent, useRef } from "react";

import { previewBridge } from "~/components/preview/previewBridge";
import { openUrlInThreadPreview } from "~/components/preview/openUrlInThreadPreview";
import { toastManager } from "~/components/ui/toast";
import { useThreadShells } from "~/state/entities";
import { previewEnvironment } from "~/state/preview";
import { useAtomCommand } from "~/state/use-atom-command";

import { threadForAccountOwner } from "./accountSignInTarget";

const QUIET_PERIOD_MS = 60 * 60_000;

/**
 * Says so when a site signs someone out, with a way back in. Once an hour per
 * account: a session that keeps ending should not turn into a stream of toasts.
 */
export function BrowserAccountNotices() {
  const threadShells = useThreadShells();
  const openPreview = useAtomCommand(previewEnvironment.open, { reportFailure: false });
  const lastShownRef = useRef(new Map<string, number>());

  const notify = useEffectEvent((event: PreviewAccountEvent) => {
    if (!isUnexpectedSignOut(event) || event.owner === null) return;
    const key = `${event.provider}\u0000${event.identity ?? ""}\u0000${event.directory}`;
    const now = Date.now();
    if (now - (lastShownRef.current.get(key) ?? 0) < QUIET_PERIOD_MS) return;
    lastShownRef.current.set(key, now);
    const owner = event.owner;
    const provider = ACCOUNT_PROVIDER_LABELS[event.provider];
    const threadId: ThreadId | null = threadForAccountOwner({
      owner,
      activeThreadId: null,
      threads: threadShells.map((shell) => ({
        id: shell.id,
        environmentId: shell.environmentId,
        projectId: shell.projectId,
        updatedAt: shell.updatedAt,
        browserProfileThreadId: shell.browserProfileThreadId,
      })),
    });
    toastManager.add({
      type: "warning",
      title: `${provider} signed you out of ${accountDisplayName(event)}`,
      ...(threadId === null
        ? {}
        : {
            actionProps: {
              children: "Sign in again",
              onClick: () => {
                void openUrlInThreadPreview({
                  threadRef: scopeThreadRef(owner.environmentId as EnvironmentId, threadId),
                  url: accountSignInUrl(event.provider, event.identity),
                  openPreview,
                  openExternally: () => undefined,
                });
              },
            },
          }),
    });
  });

  useEffect(() => previewBridge?.accounts?.onEvent((event) => notify(event)), []);

  return null;
}
