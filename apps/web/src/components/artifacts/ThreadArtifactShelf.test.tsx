// @vitest-environment happy-dom
import { AsyncResult } from "effect/unstable/reactivity";
import {
  EnvironmentId,
  ThreadArtifactId,
  ThreadArtifactKey,
  ThreadId,
  type ThreadArtifactSummary,
} from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  listResult: null as unknown,
}));

vi.mock("@effect/atom-react", () => ({
  useAtomValue: () => mocks.listResult,
}));

vi.mock("~/assets/assetUrls", () => ({
  useAssetUrl: () => null,
}));

vi.mock("~/state/threadArtifacts", () => ({
  threadArtifactEnvironment: { list: () => Symbol.for("artifact-list-query") },
}));

import { ThreadArtifactDeepLinkOpener, ThreadArtifactShelf } from "./ThreadArtifactShelf";

const threadRef = {
  environmentId: EnvironmentId.make("environment-1"),
  threadId: ThreadId.make("thread-1"),
} as const;

function artifactSummary(input: {
  readonly id: string;
  readonly title: string;
  readonly updatedAt: string;
}): ThreadArtifactSummary {
  const artifactId = ThreadArtifactId.make(input.id);
  const revision = {
    artifactId,
    revision: 1,
    entryPath: "index.html",
    contentType: "text/html",
    byteLength: 10,
    fileCount: 1,
    iconSource: "generated" as const,
    createdAt: input.updatedAt,
  };
  return {
    artifact: {
      artifactId,
      threadId: threadRef.threadId,
      key: ThreadArtifactKey.make(input.id),
      title: input.title,
      description: null,
      kind: "web",
      currentRevision: 1,
      archivedAt: null,
      createdAt: input.updatedAt,
      updatedAt: input.updatedAt,
    },
    revision,
    entryResource: {
      _tag: "artifact-revision",
      threadId: threadRef.threadId,
      artifactId,
      revision: 1,
      path: "index.html",
    },
    iconResource: {
      _tag: "artifact-icon",
      threadId: threadRef.threadId,
      artifactId,
      revision: 1,
    },
  };
}

describe("ThreadArtifactShelf ordering", () => {
  it("preserves the deterministic newest-first and id-tiebreak order from the host", () => {
    const newest = artifactSummary({
      id: "artifact-z",
      title: "Newest artifact",
      updatedAt: "2026-08-25T13:00:00.000Z",
    });
    const alpha = artifactSummary({
      id: "artifact-a",
      title: "Alpha tie",
      updatedAt: "2026-08-25T12:00:00.000Z",
    });
    const beta = artifactSummary({
      id: "artifact-b",
      title: "Beta tie",
      updatedAt: "2026-08-25T12:00:00.000Z",
    });
    mocks.listResult = AsyncResult.success({
      threadId: threadRef.threadId,
      artifacts: [newest, alpha, beta],
    });

    const markup = renderToStaticMarkup(
      <ThreadArtifactShelf
        threadRef={threadRef}
        activeArtifactId={alpha.artifact.artifactId}
        onOpen={() => undefined}
      />,
    );

    const newestIndex = markup.indexOf("Newest artifact");
    const alphaIndex = markup.indexOf("Alpha tie");
    const betaIndex = markup.indexOf("Beta tie");
    expect(newestIndex).toBeGreaterThan(-1);
    expect(newestIndex).toBeLessThan(alphaIndex);
    expect(alphaIndex).toBeLessThan(betaIndex);
    expect(markup).toContain('aria-current="page"');
    expect(markup).toMatch(/<details[^>]*\sopen[=\s>]/);
  });
});

it("waits for the artifact snapshot and reopens the same link after closing", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const summary = artifactSummary({
    id: "linked-artifact",
    title: "Linked artifact",
    updatedAt: "2026-10-07T15:00:00.000Z",
  });
  const onOpen = vi.fn();
  const root = createRoot(document.createElement("div"));
  const render = (requestedArtifactId: string | null) =>
    act(async () => {
      root.render(
        <ThreadArtifactDeepLinkOpener
          threadRef={threadRef}
          requestedArtifactId={requestedArtifactId}
          onOpen={onOpen}
        />,
      );
    });
  try {
    mocks.listResult = AsyncResult.initial();
    await render(summary.artifact.artifactId);
    expect(onOpen).not.toHaveBeenCalled();

    mocks.listResult = AsyncResult.success({ threadId: threadRef.threadId, artifacts: [summary] });
    await render(summary.artifact.artifactId);
    expect(onOpen).toHaveBeenCalledExactlyOnceWith({
      environmentId: threadRef.environmentId,
      artifactId: summary.artifact.artifactId,
      summary,
    });
    // An ordinary render or replacement snapshot must not keep reopening the tab.
    mocks.listResult = AsyncResult.success({ threadId: threadRef.threadId, artifacts: [summary] });
    await render(summary.artifact.artifactId);
    expect(onOpen).toHaveBeenCalledTimes(1);

    await render(null);
    await render(summary.artifact.artifactId);
    expect(onOpen).toHaveBeenCalledTimes(2);
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
});
