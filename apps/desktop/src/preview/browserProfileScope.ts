/**
 * The scope every preview browser guest in an environment shares.
 *
 * Chromium keys cookies, logins, and storage by partition, and the partition
 * comes from this scope. Keeping it per environment — rather than per thread,
 * as it was — is what lets an agent act on the sites the user is already
 * signed into: the agent's tab and the user's tab are the same profile.
 *
 * Environments stay separate because a remote machine's browser is a
 * different machine's browser, and its cookies are not the user's to reuse.
 */
export function previewBrowserProfileScope(
  environmentId: string,
  profileThreadId?: string | null,
): string {
  // A blank or missing id must not resolve to a profile. It used to reach a
  // default scope one layer down and open a second, empty jar, which is
  // indistinguishable from the browser being signed out of every site — the
  // exact symptom this scope exists to prevent. Fail where it is wrong.
  if (typeof environmentId !== "string" || environmentId.trim() === "") {
    throw new Error(
      "A preview browser profile needs an environment id; got " +
        (typeof environmentId === "string" ? JSON.stringify(environmentId) : typeof environmentId),
    );
  }
  // A designated profile owner (an agent-created thread carrying a
  // `browserProfileThreadId`, or its inheriting descendants, which all carry
  // the same id) gets its OWN partition, isolated from the user's shared
  // environment jar and from other agent families. The desktop used to drop
  // this field and key every tab on the environment alone, so the whole
  // per-agent isolation + cache-inheritance feature was a no-op at the cookie
  // layer. A first open of one of these partitions is seeded (cloned) from the
  // environment jar so the agent starts with the user's logins and then
  // diverges — see BrowserSession.seedProfileFromEnvironment.
  //
  // A thread with no designated owner (the user's own conversations) keeps the
  // shared environment jar so the user stays live-logged-in across their tabs,
  // which is exactly why env-scope was chosen; isolating those too would sign
  // the user out of every new thread.
  const owner = typeof profileThreadId === "string" ? profileThreadId.trim() : "";
  return owner === "" ? environmentId : `${environmentId}:thread:${owner}`;
}

/** The bare environment scope a per-thread profile is cloned from. */
export const PROFILE_SCOPE_THREAD_SEPARATOR = ":thread:";

export function environmentScopeOf(scope: string): string {
  const index = scope.indexOf(PROFILE_SCOPE_THREAD_SEPARATOR);
  return index === -1 ? scope : scope.slice(0, index);
}

export function isThreadScopedProfile(scope: string): boolean {
  return scope.includes(PROFILE_SCOPE_THREAD_SEPARATOR);
}

export interface LegacyBrowserProfile {
  readonly directory: string;
  /** Size of the profile's `Cookies` database, in bytes. */
  readonly cookieBytes: number;
}

/**
 * Pick which of the old per-thread profiles becomes the shared one.
 *
 * The switch to a single profile would otherwise read as "the update signed
 * me out of everything", because the live logins sit in whichever thread's
 * jar the user happened to sign in from. The cookie database only grows with
 * stored cookies, so the largest one is the jar with the sessions in it.
 *
 * Equal sizes are broken by name so the same inputs always adopt the same
 * profile, rather than following the order the directory happens to list in.
 */
export function selectLegacyBrowserProfile(
  profiles: ReadonlyArray<LegacyBrowserProfile>,
): string | null {
  let best: LegacyBrowserProfile | null = null;
  for (const profile of profiles) {
    // An empty jar carries no session, so adopting it would be
    // indistinguishable from starting fresh while spending the one adoption.
    if (profile.cookieBytes <= 0) continue;
    if (
      !best ||
      profile.cookieBytes > best.cookieBytes ||
      (profile.cookieBytes === best.cookieBytes && profile.directory < best.directory)
    ) {
      best = profile;
    }
  }
  return best?.directory ?? null;
}
