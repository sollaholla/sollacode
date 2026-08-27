import type { ThreadId } from "@t3tools/contracts";

export interface HostedBrowserProfileBinding {
  readonly profileThreadId: ThreadId;
}

/**
 * Resolve a browser partition exactly once for a hosted Electron guest.
 *
 * Thread shells can disappear briefly while the server reconnects. Treating
 * that gap as an own-thread profile swaps the `<webview>` partition and loses
 * the authenticated page. A new guest waits for its shell; a bound guest keeps
 * the original profile root for its entire lifetime.
 */
export function resolveHostedBrowserProfileBinding(
  current: HostedBrowserProfileBinding | null,
  shell:
    | {
        readonly threadId: ThreadId;
        readonly browserProfileThreadId: ThreadId | null | undefined;
      }
    | undefined,
): HostedBrowserProfileBinding | null {
  if (current) return current;
  if (!shell) return null;
  return { profileThreadId: shell.browserProfileThreadId ?? shell.threadId };
}
