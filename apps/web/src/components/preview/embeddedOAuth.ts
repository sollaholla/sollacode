const GOOGLE_SIGN_IN_REJECTED_PATH = /\/signin\/rejected\/?$/u;

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
