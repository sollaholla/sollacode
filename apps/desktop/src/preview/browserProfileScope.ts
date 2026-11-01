import type { PreviewBrowserProfile } from "@t3tools/contracts";

import { agentProfileScope, projectProfileScope } from "./browserProfiles.ts";

/**
 * The scope a preview browser guest's cookies, logins and cache are keyed by.
 *
 * Every thread in a project shares the project's profile, so signing in once
 * holds across that project. An agent's chat, side chats and scheduled tasks
 * share that agent's own profile, which starts signed out and never mixes with
 * a project's. Environments stay separate because a remote machine's browser is
 * a different machine's browser, and its cookies are not the user's to reuse.
 *
 * A caller with no thread at all gets the environment's own jar.
 */
export function previewBrowserProfileScope(
  environmentId: string,
  profile?: PreviewBrowserProfile | null,
): string {
  // A blank or missing id must not resolve to a profile. It used to reach a
  // default scope one layer down and open a second, empty jar, which is
  // indistinguishable from the browser being signed out of every site. Fail
  // where it is wrong.
  if (typeof environmentId !== "string" || environmentId.trim() === "") {
    throw new Error(
      "A preview browser profile needs an environment id; got " +
        (typeof environmentId === "string" ? JSON.stringify(environmentId) : typeof environmentId),
    );
  }
  if (!profile) return environmentId;
  return profile.kind === "project"
    ? projectProfileScope(environmentId, profile.projectId)
    : agentProfileScope(environmentId, profile.rootThreadId);
}
