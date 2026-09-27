import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { PreviewChromeRow } from "./PreviewChromeRow";

function renderRow(url: string, displayUrl?: string) {
  return renderToStaticMarkup(
    <PreviewChromeRow
      url={url}
      displayUrl={displayUrl}
      loading={false}
      loadProgress={0}
      canGoBack={false}
      canGoForward={false}
      refreshDisabled={false}
      onBack={() => {}}
      onForward={() => {}}
      onRefresh={() => {}}
      onSubmit={() => {}}
      onOpenInBrowser={() => {}}
    />,
  );
}

describe("preview address bar", () => {
  it("gives the open button its own layout space beside a truncated long address", () => {
    const markup = renderRow(`https://example.com/${"very-long-path/".repeat(40)}`);
    expect(markup).toContain('aria-label="Open in system browser"');
    expect(markup).toContain("truncate");
    const addon = markup.match(/class="([^"]*)" data-align="inline-end"/u)?.[1];
    expect(addon).toContain("shrink-0");
    expect(addon).not.toContain("absolute");
  });

  it.each([
    "http://localhost:3000/",
    "http://192.168.1.2:8080/",
    "https://host.tail123.ts.net/",
    "about:blank",
  ])("hides the client open action for %s", (url) => {
    expect(renderRow(url)).not.toContain('aria-label="Open in system browser"');
  });

  it("checks the actual URL instead of a friendlier display address", () => {
    expect(renderRow("http://localhost:3000/", "https://example.com/")).not.toContain(
      'aria-label="Open in system browser"',
    );
  });
});
