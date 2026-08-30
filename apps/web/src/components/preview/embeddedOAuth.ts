const GOOGLE_SIGN_IN_REJECTED_PATH = /\/signin\/rejected\/?$/u;
const GOOGLE_HANDOFF_HOSTS = ["google.com", "youtube.com"] as const;

function isTrustedGoogleHandoffUrl(url: URL): boolean {
  return (
    url.protocol === "https:" &&
    GOOGLE_HANDOFF_HOSTS.some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`))
  );
}

/**
 * Google deliberately refuses OAuth inside embedded browser surfaces. This is
 * not a transient navigation failure: retrying in the same guest produces the
 * same wall, so Preview must offer a supported system-browser handoff.
 */
export function isEmbeddedOAuthRejected(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === "https:" &&
      parsed.hostname === "accounts.google.com" &&
      GOOGLE_SIGN_IN_REJECTED_PATH.test(parsed.pathname)
    );
  } catch {
    return false;
  }
}

/**
 * Google's rejection URL is a terminal error page, not an OAuth entry point.
 * Opening it in a different browser produces a malformed-request error because
 * that browser does not own the embedded flow. Google's `continue` URL can
 * itself be a stale sign-in wrapper, so prefer its final trusted `next`
 * destination and let that page start a completely fresh supported flow.
 */
export function resolveEmbeddedOAuthHandoffUrl(url: string): string | null {
  if (!isEmbeddedOAuthRejected(url)) return null;

  try {
    const continueUrl = new URL(url).searchParams.get("continue");
    if (!continueUrl) return null;

    const parsed = new URL(continueUrl);
    const nextUrl = parsed.searchParams.get("next");
    if (nextUrl) {
      const next = new URL(nextUrl);
      if (isTrustedGoogleHandoffUrl(next)) return next.toString();
    }
    return isTrustedGoogleHandoffUrl(parsed) ? parsed.toString() : null;
  } catch {
    return null;
  }
}

export function openPreviewUrlInSystemBrowser(input: {
  readonly url: string;
  readonly openNative?: ((url: string) => Promise<unknown>) | undefined;
  readonly openWeb: (url: string) => void;
}): void {
  if (input.openNative) {
    void input.openNative(input.url).catch(() => undefined);
    return;
  }
  input.openWeb(input.url);
}
