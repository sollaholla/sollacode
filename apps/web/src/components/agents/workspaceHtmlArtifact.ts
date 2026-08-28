/**
 * Build the Dashboard HTML document an agent publishes as its workspace artifact.
 *
 * A complete document (`<!DOCTYPE` / `<html>`) is served as-is; a fragment is
 * wrapped. Optional CSS is injected into `<head>` so agents can ship a
 * stylesheet without rewriting the markup. The resulting string is the iframe
 * `srcDoc` — same isolation as a thread web artifact (`allow-scripts` only).
 */
export function buildWorkspaceHtmlDocument(input: {
  readonly html: string;
  readonly css?: string | undefined;
}): string {
  const html = input.html.trim();
  const css = input.css?.trim() ?? "";
  const styleTag = css.length > 0 ? `<style>${css}</style>` : "";
  if (isCompleteHtmlDocument(html)) {
    if (styleTag.length === 0) return html;
    if (/<\/head>/iu.test(html)) return html.replace(/<\/head>/iu, `${styleTag}</head>`);
    return html.replace(/<html\b[^>]*>/iu, (open) => `${open}<head>${styleTag}</head>`);
  }
  return [
    "<!DOCTYPE html>",
    '<html><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    styleTag,
    "</head><body>",
    html,
    "</body></html>",
  ].join("");
}

export function isCompleteHtmlDocument(html: string): boolean {
  return /<!DOCTYPE/iu.test(html) || /<html[\s>]/iu.test(html);
}
