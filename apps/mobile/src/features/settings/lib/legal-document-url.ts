const FORK_NOTICES_URL =
  "https://github.com/sollaholla/sollacode/blob/main/docs/reference/project-notices.md";

function resolveMarketingSiteUrl(override: string | undefined): URL | null {
  if (!override?.trim()) return null;
  try {
    const url = new URL(override.trim());
    if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password) {
      return null;
    }
    url.search = "";
    url.hash = "";
    url.pathname = `${url.pathname.replace(/\/+$/, "")}/`;
    return url;
  } catch {
    return null;
  }
}

const MARKETING_SITE_URL = resolveMarketingSiteUrl(process.env.EXPO_PUBLIC_MARKETING_SITE_URL);

function marketingSiteDocumentUrl(path: string, section: string): string {
  return MARKETING_SITE_URL
    ? new URL(path, MARKETING_SITE_URL).toString()
    : `${FORK_NOTICES_URL}#${section}`;
}

export const PRIVACY_POLICY_URL = marketingSiteDocumentUrl(
  "privacy-policy",
  "data-and-connected-services",
);
export const SECURITY_POLICY_URL = marketingSiteDocumentUrl("security-policy", "security");
export const TERMS_OF_SERVICE_URL = marketingSiteDocumentUrl("terms-of-service", "license");
export const LEGAL_URL = marketingSiteDocumentUrl("legal", "solla-code-project-notices");

export const ALLOWED_LEGAL_DOCUMENT_URLS = [
  LEGAL_URL,
  PRIVACY_POLICY_URL,
  TERMS_OF_SERVICE_URL,
  SECURITY_POLICY_URL,
] as const;

function webDocumentIdentity(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;

    const pathname = url.pathname.replace(/\/+$/, "") || "/";
    return `${url.origin}${pathname}`;
  } catch {
    return null;
  }
}

const ALLOWED_LEGAL_DOCUMENT_IDENTITIES = new Set(
  ALLOWED_LEGAL_DOCUMENT_URLS.map(webDocumentIdentity).filter(
    (value): value is string => value !== null,
  ),
);

export function isLegalDocumentUrl(value: string): boolean {
  const identity = webDocumentIdentity(value);
  return identity !== null && ALLOWED_LEGAL_DOCUMENT_IDENTITIES.has(identity);
}
