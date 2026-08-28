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
export function previewBrowserProfileScope(environmentId: string): string {
  return environmentId;
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
