import { describe, expect, it } from "vite-plus/test";
import { ThreadArtifactId, ThreadId } from "@t3tools/contracts";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  ArtifactDeepLinkButton,
  artifactFrameSandbox,
  resolveArtifactContentResource,
} from "./ThreadArtifactSurface";

describe("artifact toolbar navigation", () => {
  it("uses an SPA action button rather than a full-document anchor", () => {
    const markup = renderToStaticMarkup(
      createElement(ArtifactDeepLinkButton, { onNavigate: () => undefined }),
    );

    expect(markup).toContain('<button type="button"');
    expect(markup).not.toContain("href=");
  });
});

describe("artifact iframe isolation", () => {
  it("allows only interactive scripts", () => {
    expect(artifactFrameSandbox("web")).toBe("allow-scripts");
  });

  it("gives non-web documents no sandbox capabilities", () => {
    expect(artifactFrameSandbox("markdown")).toBe("");
    expect(artifactFrameSandbox("pdf")).toBe("");
  });
});

describe("artifact revision resources", () => {
  const threadId = ThreadId.make("thread-1");
  const artifactId = ThreadArtifactId.make("artifact-1");
  const revision = {
    artifactId,
    revision: 2,
    entryPath: "nested/index.html",
    contentType: "text/html",
    byteLength: 10,
    fileCount: 1,
    iconSource: "generated" as const,
    createdAt: "2026-08-21T00:00:00.000Z",
  };

  it("passes the exact current entry resource, including its path", () => {
    const entryResource = {
      _tag: "artifact-revision" as const,
      threadId,
      artifactId,
      revision: 2,
      path: "nested/index.html",
    };
    expect(
      resolveArtifactContentResource({
        threadId,
        artifactId,
        displayedRevision: 2,
        summary: { entryResource, revision },
        detail: null,
      }),
    ).toEqual(entryResource);
  });

  it("uses historical revision metadata rather than dropping the entry path", () => {
    expect(
      resolveArtifactContentResource({
        threadId,
        artifactId,
        displayedRevision: 2,
        summary: null,
        detail: {
          entryResource: {
            _tag: "artifact-revision",
            threadId,
            artifactId,
            revision: 3,
            path: "index.html",
          },
          revisions: [revision],
        },
      }),
    ).toEqual({
      _tag: "artifact-revision",
      threadId,
      artifactId,
      revision: 2,
      path: "nested/index.html",
    });
  });
});
