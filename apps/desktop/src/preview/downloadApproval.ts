/**
 * Whether a download may write into the user's workspace without asking.
 *
 * Downloads no longer raise the system save panel, which means a page — or an
 * agent driving one — can now put a file in the user's workspace with no
 * prompt and no click. That is a real capability, so it is gated: the first
 * download from a domain asks, and the answer can be remembered for that
 * domain or spent on the one file.
 *
 * The decision is keyed by domain rather than by page URL. A site that fetches
 * from its own CDN should not re-ask per file, and a user who trusts
 * "grok.com" means the site, not one URL on it.
 *
 * Answers live for as long as the app runs and are deliberately not persisted.
 * A standing grant that outlives the session is a bigger promise than "yes,
 * download that", and re-asking once per launch is cheap.
 */
export type DownloadApproval = "allowed" | "ask";

export function resolveDownloadApproval(input: {
  readonly domain: string;
  readonly allowedDomains: ReadonlySet<string>;
}): DownloadApproval {
  if (input.domain.length === 0) return "ask";
  return input.allowedDomains.has(input.domain) ? "allowed" : "ask";
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

/**
 * What an answer does to the held file, once its bytes have landed in staging.
 *
 * Splitting this out keeps the part worth testing — that "allow once" grants
 * nothing beyond this file, and that a denial never keeps bytes — away from
 * Electron's `DownloadItem`, which cannot be exercised in a unit test.
 */
export function resolveDownloadApprovalEffects(decision: "allow-domain" | "allow-once" | "deny"): {
  readonly keepFile: boolean;
  readonly rememberDomain: boolean;
} {
  return {
    keepFile: decision !== "deny",
    rememberDomain: decision === "allow-domain",
  };
}
