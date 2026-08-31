/**
 * Whether a download may write into the user's workspace without asking.
 *
 * Downloads no longer raise the system save panel, which means a page — or an
 * agent driving one — can now put a file in the user's workspace with no
 * prompt and no click. That is a real capability, so it is gated: the first
 * download from a domain asks, and the answer can be remembered for that
 * domain or spent on the one file.
 *
 * The decision is keyed by SITE — the registrable domain of the page the
 * download came from — not by the file's own host. Keying on the exact host
 * asks again for every CDN and every subdomain a site downloads through:
 * allowing "suno.com" covered neither `studio.suno.com` nor the
 * `cdn1.suno.ai` the file actually streams from, so a single answer never
 * held. Trusting the site the user is looking at is both what "Allow for this
 * domain" reads as and what browsers scope their own automatic-download
 * permission to.
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
 * Suffixes under which each subdomain is a separate party, so collapsing to
 * the last two labels would hand one tenant an answer meant for another.
 * Country second-levels plus the hosting suffixes this app actually meets —
 * `ts.net` above all, since every tailnet lives under it.
 *
 * This is a deliberately small stand-in for the public suffix list. Being
 * wrong here costs an extra prompt (a suffix we treat as a site) or an
 * over-broad grant (a site we treat as a suffix), so the list errs toward
 * listing anything multi-tenant.
 */
const MULTI_LABEL_PUBLIC_SUFFIXES = new Set([
  "co.uk",
  "org.uk",
  "ac.uk",
  "gov.uk",
  "me.uk",
  "net.uk",
  "sch.uk",
  "com.au",
  "net.au",
  "org.au",
  "edu.au",
  "gov.au",
  "id.au",
  "co.nz",
  "net.nz",
  "org.nz",
  "govt.nz",
  "ac.nz",
  "co.jp",
  "or.jp",
  "ne.jp",
  "ac.jp",
  "go.jp",
  "co.kr",
  "or.kr",
  "com.br",
  "net.br",
  "org.br",
  "gov.br",
  "com.cn",
  "net.cn",
  "org.cn",
  "gov.cn",
  "edu.cn",
  "co.in",
  "net.in",
  "org.in",
  "gen.in",
  "co.za",
  "org.za",
  "net.za",
  "co.il",
  "org.il",
  "ac.il",
  "com.mx",
  "com.ar",
  "com.co",
  "com.tr",
  "com.tw",
  "com.sg",
  "com.hk",
  "com.my",
  "com.ph",
  "com.vn",
  "com.pk",
  "com.sa",
  "com.eg",
  "com.ng",
  "com.ua",
  "com.pl",
  "com.es",
  "com.pt",
  "com.ru",
  // Multi-tenant hosting: one label down is a different owner.
  "ts.net",
  "github.io",
  "gitlab.io",
  "pages.dev",
  "workers.dev",
  "r2.dev",
  "vercel.app",
  "netlify.app",
  "web.app",
  "herokuapp.com",
  "ngrok.io",
  "ngrok-free.app",
  "trycloudflare.com",
]);

/**
 * The site a hostname belongs to: `cdn1.suno.ai` and `audiopipe.suno.ai` are
 * both `suno.ai`, `studio.suno.com` is `suno.com`.
 *
 * IP literals and single labels (`localhost`) are already the whole site and
 * are returned untouched — splitting an address on dots would otherwise turn
 * `127.0.0.1` into "0.1".
 */
export function registrableDomain(hostname: string): string {
  const host = hostname.trim().toLowerCase().replace(/\.$/, "");
  if (host.length === 0) return "";
  // IPv6 arrives bracketed from URL.hostname; IPv4 is all digits and dots.
  if (host.startsWith("[") || /^\d+(\.\d+)*$/.test(host)) return host;
  const labels = host.split(".").filter((label) => label.length > 0);
  if (labels.length <= 2) return labels.join(".");
  const lastTwo = labels.slice(-2).join(".");
  return MULTI_LABEL_PUBLIC_SUFFIXES.has(lastTwo) ? labels.slice(-3).join(".") : lastTwo;
}

/**
 * The site a download should be attributed to.
 *
 * The page the download started from wins over the file's own host, because a
 * site streaming from its own CDN (or a third-party one) is still that site
 * asking — and answering for `cdn1.suno.ai` grants nothing the next file
 * needs. The file's host is the fallback for the cases with no page to speak
 * for them.
 *
 * Three URL shapes have to work, because the common one has no hostname:
 *
 * - `https://grok.com/f.mp4` — the plain case, the host.
 * - `blob:https://grok.com/<uuid>` — how most web apps hand over a file they
 *   built in the page. `new URL(...).hostname` is empty for these, so without
 *   unwrapping the `blob:` prefix every such download is unattributable and
 *   "Allow for this domain" can never be offered — which is exactly how it
 *   shipped greyed out.
 * - `data:` and `blob:null` — genuinely hostless, so the page is the only
 *   answer available, and the right one.
 *
 * Still empty means unattributable, which {@link resolveDownloadApproval}
 * treats as "ask" — the kind that must not slip through a remembered answer.
 */
export function downloadDomain(rawUrl: string, pageUrl = ""): string {
  const page = registrableDomain(hostnameOf(pageUrl));
  if (page.length > 0) return page;
  const direct = registrableDomain(hostnameOf(rawUrl));
  if (direct.length > 0) return direct;
  if (rawUrl.startsWith("blob:")) {
    return registrableDomain(hostnameOf(rawUrl.slice("blob:".length)));
  }
  return "";
}

export function resolveDownloadApprovalEffects(decision: "allow-domain" | "allow-once" | "deny"): {
  readonly keepFile: boolean;
  readonly rememberDomain: boolean;
} {
  return {
    keepFile: decision !== "deny",
    rememberDomain: decision === "allow-domain",
  };
}
