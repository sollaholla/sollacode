import { isAgentsProjectId, type PreviewBrowserProfile, type ThreadId } from "@t3tools/contracts";

export interface HostedBrowserProfileBinding {
  readonly profile: PreviewBrowserProfile;
}

/** What is needed from a thread to decide whose browser profile it uses. */
export interface BrowserProfileThread {
  readonly threadId: ThreadId;
  readonly projectId: string;
  readonly browserProfileThreadId: ThreadId | null | undefined;
  /** The project of the thread named by `browserProfileThreadId`, if it still exists. */
  readonly profileRootProjectId: string | undefined;
}

/**
 * Whose cookies, logins and cache a thread's browser uses.
 *
 * A thread in a project shares that project's. An agent's own threads share the
 * agent's, including a thread the agent opened in someone else's project, which
 * is why the owner's project decides and not the thread's own. A thread whose
 * owner has been deleted falls back to the project it is in.
 */
export function resolveBrowserProfile(thread: BrowserProfileThread): PreviewBrowserProfile {
  const owningProjectId = thread.profileRootProjectId ?? thread.projectId;
  if (isAgentsProjectId(owningProjectId)) {
    return { kind: "agent", rootThreadId: thread.browserProfileThreadId ?? thread.threadId };
  }
  return { kind: "project", projectId: thread.projectId };
}

/** Index thread shells for profile decisions, resolving each owner's project once. */
export function browserProfileThreadsByKey<
  Shell extends {
    readonly id: ThreadId;
    readonly projectId: string;
    readonly browserProfileThreadId?: ThreadId | null | undefined;
  },
>(
  shells: ReadonlyArray<Shell>,
  keyOf: (shell: Shell) => string,
  rootKeyOf: (shell: Shell, rootId: ThreadId) => string,
): ReadonlyMap<string, BrowserProfileThread> {
  const projectByKey = new Map(shells.map((shell) => [keyOf(shell), shell.projectId]));
  return new Map(
    shells.map((shell) => [
      keyOf(shell),
      {
        threadId: shell.id,
        projectId: shell.projectId,
        browserProfileThreadId: shell.browserProfileThreadId,
        profileRootProjectId: shell.browserProfileThreadId
          ? projectByKey.get(rootKeyOf(shell, shell.browserProfileThreadId))
          : undefined,
      },
    ]),
  );
}

/** A stable string for a profile, so one atom serves every thread sharing it. */
export function browserProfileKey(profile: PreviewBrowserProfile): string {
  return profile.kind === "project"
    ? `project:${profile.projectId}`
    : `agent:${profile.rootThreadId}`;
}

export function parseBrowserProfileKey(key: string): PreviewBrowserProfile | undefined {
  if (key.startsWith("project:")) return { kind: "project", projectId: key.slice(8) };
  if (key.startsWith("agent:")) {
    return { kind: "agent", rootThreadId: key.slice(6) as ThreadId };
  }
  return undefined;
}

/**
 * Resolve a browser partition exactly once for a hosted Electron guest.
 *
 * Thread shells can disappear briefly while the server reconnects. Treating
 * that gap as a different profile swaps the `<webview>` partition and loses the
 * authenticated page. A new guest waits for its shell; a bound guest keeps its
 * original profile for its entire lifetime.
 */
export function resolveHostedBrowserProfileBinding(
  current: HostedBrowserProfileBinding | null,
  shell: BrowserProfileThread | undefined,
): HostedBrowserProfileBinding | null {
  if (current) return current;
  if (!shell) return null;
  return { profile: resolveBrowserProfile(shell) };
}
