import { AsyncResult } from "effect/unstable/reactivity";
import {
  EnvironmentId,
  ThreadArtifactId,
  ThreadArtifactKey,
  ThreadId,
  type ThreadArtifactSummary,
} from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  listResult: null as unknown,
  setThreadPanelExpanded: vi.fn(),
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

vi.mock("../../uiStateStore", () => ({
  THREAD_PANEL_ARTIFACTS: "artifacts",
  useUiStateStore: (selector: (state: object) => unknown) =>
    selector({
      threadPanelExpandedById: new Proxy(
        {},
        {
          get: () => ({ artifacts: true }),
        },
      ),
      setThreadPanelExpanded: mocks.setThreadPanelExpanded,
    }),
}));

import { ThreadArtifactShelf } from "./ThreadArtifactShelf";

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
  beforeEach(() => {
    mocks.setThreadPanelExpanded.mockClear();
  });

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
  });
});
