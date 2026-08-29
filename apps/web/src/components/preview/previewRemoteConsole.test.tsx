import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { PreviewRemoteConsole } from "./PreviewRemoteConsole";

const at = "2026-08-29T00:00:00.000Z";

describe("PreviewRemoteConsole", () => {
  it("shows console output and says so when there is none", () => {
    expect(
      renderToStaticMarkup(
        <PreviewRemoteConsole consoleEntries={undefined} networkEntries={undefined} />,
      ),
    ).toContain("No console output");

    expect(
      renderToStaticMarkup(
        <PreviewRemoteConsole
          consoleEntries={[{ level: "error", text: "boom", timestamp: at }]}
          networkEntries={undefined}
        />,
      ),
    ).toContain("boom");
  });

  it("reports only requests that actually went wrong", () => {
    const markup = renderToStaticMarkup(
      <PreviewRemoteConsole
        consoleEntries={[]}
        networkEntries={[
          {
            url: "https://ok.example/fine",
            method: "GET",
            status: 200,
            failed: false,
            timestamp: at,
          },
          {
            url: "https://ok.example/missing",
            method: "GET",
            status: 404,
            failed: false,
            timestamp: at,
          },
          {
            url: "https://ok.example/dead",
            method: "POST",
            status: null,
            failed: true,
            timestamp: at,
          },
        ]}
      />,
    );
    // A successful request is noise in a panel opened to find a problem.
    expect(markup).not.toContain("/fine");
    expect(markup).toContain("/missing");
    expect(markup).toContain("/dead");
  });
});
