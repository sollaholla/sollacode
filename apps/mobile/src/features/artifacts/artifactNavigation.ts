/**
 * Keeps an artifact WebView on the signed asset subtree selected by the host.
 * The asset response also carries a CSP sandbox; this is the native navigation
 * boundary for links and script-driven top-level navigations.
 */
export function isAllowedArtifactNavigation(candidateUrl: string, entryUrl: string): boolean {
  if (candidateUrl === "about:blank") return true;

  try {
    const candidate = new URL(candidateUrl);
    const entry = new URL(entryUrl);
    if (candidate.origin !== entry.origin) return false;

    const entryDirectory = entry.pathname.endsWith("/")
      ? entry.pathname
      : entry.pathname.slice(0, entry.pathname.lastIndexOf("/") + 1);
    return candidate.pathname === entry.pathname || candidate.pathname.startsWith(entryDirectory);
  } catch {
    return false;
  }
}
