/**
 * Which sites may use a passkey Solla holds.
 *
 * A site is its registrable domain near enough, since a passkey registered at
 * `login.example.com` usually names `example.com` and is used across that
 * domain's hosts. This only decides where the authenticator is switched on: the
 * browser still checks every passkey's domain against the page asking for it,
 * so an over-broad guess here cannot hand a passkey to the wrong site.
 */

const isLoopbackOrAddress = (host: string): boolean =>
  host === "localhost" ||
  host.endsWith(".localhost") ||
  host.startsWith("[") ||
  /^\d{1,3}(\.\d{1,3}){3}$/.test(host);

/** The site a host belongs to: `app.example.com` and `example.co.uk` style names. */
export function passkeySiteForHost(rawHost: string): string {
  const host = rawHost.toLowerCase();
  if (isLoopbackOrAddress(host)) return host;
  const labels = host.split(".");
  const last = labels.at(-1) ?? "";
  const second = labels.at(-2) ?? "";
  // Country suffixes like co.uk and com.au put the name one label further in.
  const keep = last.length === 2 && second.length <= 3 ? 3 : 2;
  return labels.slice(-keep).join(".");
}

/** The site of a page that may use passkeys, or null if it can't: HTTPS or loopback only. */
export function passkeySiteForUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    const secure =
      parsed.protocol === "https:" ||
      (parsed.protocol === "http:" && isLoopbackOrAddress(parsed.hostname));
    return secure && parsed.hostname ? passkeySiteForHost(parsed.hostname) : null;
  } catch {
    return null;
  }
}

/** The site named by what a person typed, whether a bare domain or a whole address. */
export function passkeySiteFromInput(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  return passkeySiteForUrl(
    /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`,
  );
}

/**
 * Google refuses a browser with a debugger attached, which the authenticator
 * needs, so turning this on would break signing in to Google altogether.
 */
export function isPasskeySiteRefused(site: string): boolean {
  return site === "google.com" || site.endsWith(".google.com");
}
