/**
 * Connection failures surface in banners, toasts, and logs that people
 * screenshot and paste into issues, and a remote environment endpoint names a
 * machine on the user's private network. The scheme, port, and path are what
 * make such an error actionable, so they stay; the host — the only part that
 * says where the machine actually lives — is replaced with a fixed mask.
 */
export const REDACTED_HOST = "•••••";

/** Literal addresses, for strings that are not parseable URLs. */
const IPV4_PATTERN = /\b\d{1,3}(?:\.\d{1,3}){3}\b/gu;
const BRACKETED_IPV6_PATTERN = /\[[0-9A-Fa-f:]+\]/gu;

/**
 * Replaces the host of an endpoint with {@link REDACTED_HOST}, keeping the
 * scheme, port, and path intact.
 *
 * Deliberately a redaction rather than a visual blur: a blurred value still
 * ships the real host in the DOM and in anything copied out of it, and these
 * strings travel far beyond the banner they were written for.
 */
export function redactEndpointHost(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) return value;
  try {
    const url = new URL(trimmed);
    const port = url.port === "" ? "" : `:${url.port}`;
    return `${url.protocol}//${REDACTED_HOST}${port}${url.pathname}${url.search}`;
  } catch {
    // A bare `host:port`, or a string that was already truncated upstream.
    // Mask literal addresses in place rather than handing it back untouched.
    return trimmed
      .replace(BRACKETED_IPV6_PATTERN, REDACTED_HOST)
      .replace(IPV4_PATTERN, REDACTED_HOST);
  }
}
