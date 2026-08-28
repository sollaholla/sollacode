import { describe, expect, it } from "vite-plus/test";

import { buildWorkspaceHtmlDocument, isCompleteHtmlDocument } from "./workspaceHtmlArtifact";

describe("workspace HTML artifacts", () => {
  it("wraps a fragment and injects optional CSS", () => {
    const document = buildWorkspaceHtmlDocument({
      html: "<h1>Inbox</h1>",
      css: "h1 { color: navy }",
    });
    expect(isCompleteHtmlDocument(document)).toBe(true);
    expect(document).toContain("<!DOCTYPE html>");
    expect(document).toContain("<h1>Inbox</h1>");
    expect(document).toContain("<style>h1 { color: navy }</style>");
  });

  it("keeps a complete document and injects CSS before </head>", () => {
    const document = buildWorkspaceHtmlDocument({
      html: "<!DOCTYPE html><html><head><title>Board</title></head><body><p>Ready</p></body></html>",
      css: "p { margin: 0 }",
    });
    expect(document).toContain("<title>Board</title><style>p { margin: 0 }</style></head>");
    expect(document).toContain("<p>Ready</p>");
  });

  it("does not wrap a complete document when no CSS is supplied", () => {
    const html = "<html><body>Dashboard</body></html>";
    expect(buildWorkspaceHtmlDocument({ html })).toBe(html);
  });
});
