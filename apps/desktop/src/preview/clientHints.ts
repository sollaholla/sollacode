/**
 * Electron IS Chromium, not Google Chrome, so its User-Agent Client Hints
 * (`Sec-CH-UA` and `Sec-CH-UA-Full-Version-List`) advertise a `"Chromium"`
 * brand and never a `"Google Chrome"` one. Cleaning the UA *string* (see
 * `BrowserSession`) does not touch these headers — they are derived from the
 * real browser brand list, not the UA override.
 *
 * Google's sign-in integrity gate reads these client-hint headers server-side.
 * A request that presents as Chromium-but-not-Chrome is redirected to
 * `accounts.google.com/v3/signin/rejected` ("this browser or app may not be
 * secure") *after* the account chooser, at the credential step. Measured
 * 2026-08-30 on a build whose UA string was already clean Chrome:
 * `navigator.userAgent` = Chrome, but `navigator.userAgentData.brands` =
 * `[Not-A.Brand, Chromium]` with no Google Chrome brand — and clicking an
 * account jumped straight to `/signin/rejected` before any password prompt.
 * That is why every prior fix that only edited the UA string still failed.
 *
 * Presenting the same coherent Chrome identity in the client hints as in the
 * UA string closes that gap. Real Chrome carries BOTH a `"Chromium"` and a
 * `"Google Chrome"` brand (plus a GREASE entry), so we append a
 * `"Google Chrome"` brand at the version Chromium already reports — the major
 * version for `Sec-CH-UA`, the full version for `Sec-CH-UA-Full-Version-List`.
 */

const BRAND_CLIENT_HINT_HEADERS: ReadonlySet<string> = new Set([
  "sec-ch-ua",
  "sec-ch-ua-full-version-list",
]);

/**
 * Given a `Sec-CH-UA`-style brand list, append a `"Google Chrome"` brand at the
 * same version Chromium reports. Idempotent (returns the value unchanged when a
 * Google Chrome brand is already present) and safe (returns the value unchanged
 * when no Chromium brand is found to copy a version from).
 */
export function withGoogleChromeBrand(headerValue: string): string {
  if (!headerValue || /"Google Chrome"/i.test(headerValue)) return headerValue;
  const chromium = headerValue.match(/"Chromium";\s*v="([^"]+)"/i);
  if (!chromium) return headerValue;
  return `${headerValue}, "Google Chrome";v="${chromium[1]}"`;
}

/**
 * Rewrite the brand-carrying client-hint headers of an outgoing request so the
 * guest presents a coherent Google Chrome identity. Returns the same object
 * reference when nothing changed, so the caller can hand Electron's callback
 * the untouched headers on the overwhelmingly common non-Google request.
 */
export function withChromeClientHintBrand(
  requestHeaders: Record<string, string>,
): Record<string, string> {
  let mutated = false;
  const next: Record<string, string> = {};
  for (const [name, value] of Object.entries(requestHeaders)) {
    if (typeof value === "string" && BRAND_CLIENT_HINT_HEADERS.has(name.toLowerCase())) {
      const rewritten = withGoogleChromeBrand(value);
      next[name] = rewritten;
      if (rewritten !== value) mutated = true;
    } else {
      next[name] = value;
    }
  }
  return mutated ? next : requestHeaders;
}
