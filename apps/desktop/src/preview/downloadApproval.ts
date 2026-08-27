/**
 * Whether a download may start without asking the user.
 *
 * Downloads no longer raise the system save panel, which means a page — or an
 * agent driving one — can now write a file into the user's workspace with no
 * prompt and no click. That is a real capability, so it is gated: the first
 * download from a domain asks, and the answer can be remembered for that
 * domain or spent on the one file.
 *
 * The decision is keyed by domain rather than by page URL. A site that fetches
 * from its own CDN should not re-ask per file, and a user who trusts
 * "grok.com" means the site, not one URL on it.
 */
export type DownloadApproval = "allowed" | "ask";

export function resolveDownloadApproval(input: {
  readonly domain: string;
  readonly allowedDomains: ReadonlySet<string>;
  /** Set once by an "Allow once" answer, and spent by this download. */
  readonly oneTimeGrant: string | null;
}): DownloadApproval {
  if (input.domain.length === 0) return "ask";
  if (input.allowedDomains.has(input.domain)) return "allowed";
  return input.oneTimeGrant === input.domain ? "allowed" : "ask";
}

/**
 * The domain a download should be attributed to.
 *
 * Falls back to the empty string for anything unparseable, which
 * {@link resolveDownloadApproval} treats as "ask" — an unattributable download
 * is exactly the kind that should not slip through on a remembered answer.
 */
export function downloadDomain(rawUrl: string): string {
  try {
    return new URL(rawUrl).hostname.toLowerCase();
  } catch {
    return "";
  }
}
