const CROSS_ORIGIN_OPENER_POLICY = "cross-origin-opener-policy";

const OPENER_SEVERING_POLICIES: ReadonlySet<string> = new Set([
  "noopener-allow-popups",
  "restrict-properties",
  "same-origin",
  "same-origin-allow-popups",
]);

export interface PreservedPopupOpenerHeaders {
  readonly changed: boolean;
  readonly responseHeaders: Record<string, string[]>;
}

/**
 * Keep an OAuth child in the opener's browsing context group while it crosses
 * an identity provider and returns to the site that launched it.
 *
 * Chromium correctly honors COOP by severing `window.opener`. That is useful
 * for ordinary top-level pages, but it strands popup OAuth implementations
 * whose return page must post a result to the opener. This transformation is
 * only installed for top-level responses in BrowserWindows already registered
 * as preview child windows; report-only headers and all non-popup traffic stay
 * untouched.
 */
export function preservePopupOpenerHeaders(
  responseHeaders: Record<string, string[]>,
): PreservedPopupOpenerHeaders {
  let changed = false;
  const nextHeaders: Record<string, string[]> = {};

  for (const [name, values] of Object.entries(responseHeaders)) {
    if (name.toLowerCase() !== CROSS_ORIGIN_OPENER_POLICY) {
      nextHeaders[name] = values;
      continue;
    }

    nextHeaders[name] = values.map((value) => {
      const policy = value.split(";", 1)[0]?.trim().toLowerCase();
      if (!policy || !OPENER_SEVERING_POLICIES.has(policy)) return value;
      changed = true;
      return "unsafe-none";
    });
  }

  return { changed, responseHeaders: changed ? nextHeaders : responseHeaders };
}
