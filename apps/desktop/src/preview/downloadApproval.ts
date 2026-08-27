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

function hostnameOf(rawUrl: string): string {
  try {
    return new URL(rawUrl).hostname.toLowerCase();
  } catch {
    return "";
  }
}

/**
 * The domain a download should be attributed to.
 *
 * Three shapes have to work, because the common one has no hostname at all:
 *
 * - `https://grok.com/f.mp4` — the plain case, the host.
 * - `blob:https://grok.com/<uuid>` — how most web apps hand over a file they
 *   built in the page. `new URL(...).hostname` is empty for these, so without
 *   unwrapping the `blob:` prefix every such download is unattributable and
 *   "Allow for this domain" can never be offered — which is exactly how it
 *   shipped greyed out.
 * - `data:` and `blob:null` — genuinely hostless, so fall back to the page
 *   that started the download. Trusting the site the user is looking at is
 *   both what they mean and the only answer available.
 *
 * Still empty means unattributable, which {@link resolveDownloadApproval}
 * treats as "ask" — the kind that must not slip through a remembered answer.
 */
export function downloadDomain(rawUrl: string, pageUrl = ""): string {
  const direct = hostnameOf(rawUrl);
  if (direct.length > 0) return direct;
  if (rawUrl.startsWith("blob:")) {
    const inner = hostnameOf(rawUrl.slice("blob:".length));
    if (inner.length > 0) return inner;
  }
  return hostnameOf(pageUrl);
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
