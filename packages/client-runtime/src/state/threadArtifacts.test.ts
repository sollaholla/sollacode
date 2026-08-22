import {
  EnvironmentId,
  ThreadArtifactId,
  ThreadArtifactKey,
  ThreadId,
  type ThreadArtifactSummary,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  threadArtifactDeepLink,
  threadArtifactIconResource,
  threadArtifactRevisionResource,
} from "./threadArtifacts.ts";

const summary: ThreadArtifactSummary = {
  artifact: {
    artifactId: ThreadArtifactId.make("dashboard"),
    threadId: ThreadId.make("thread-1"),
    key: ThreadArtifactKey.make("dashboard"),
    title: "Dashboard",
    description: null,
    kind: "web",
    currentRevision: 3,
    archivedAt: null,
    createdAt: "2026-08-21T00:00:00.000Z",
    updatedAt: "2026-08-21T00:02:00.000Z",
  },
  revision: {
    artifactId: ThreadArtifactId.make("dashboard"),
    revision: 3,
    entryPath: "index.html",
    contentType: "text/html",
    byteLength: 1024,
    fileCount: 2,
    iconSource: "generated",
    createdAt: "2026-08-21T00:02:00.000Z",
  },
  entryResource: {
    _tag: "artifact-revision",
    threadId: ThreadId.make("thread-1"),
    artifactId: ThreadArtifactId.make("dashboard"),
    revision: 3,
    path: "index.html",
  },
  iconResource: {
    _tag: "artifact-icon",
    threadId: ThreadId.make("thread-1"),
    artifactId: ThreadArtifactId.make("dashboard"),
    revision: 3,
  },
};

describe("thread artifacts", () => {
  it("pins content and icon resources to the displayed revision", () => {
    expect(threadArtifactRevisionResource(summary)).toEqual({
      _tag: "artifact-revision",
      threadId: ThreadId.make("thread-1"),
      artifactId: ThreadArtifactId.make("dashboard"),
      revision: 3,
      path: "index.html",
    });
    expect(threadArtifactIconResource(summary)).toEqual({
      _tag: "artifact-icon",
      threadId: ThreadId.make("thread-1"),
      artifactId: ThreadArtifactId.make("dashboard"),
      revision: 3,
    });
  });

  it("builds an environment-qualified deep link", () => {
    expect(
      threadArtifactDeepLink(
        {
          environmentId: EnvironmentId.make("remote host"),
          threadId: ThreadId.make("thread/1"),
        },
        ThreadArtifactId.make("artifact one"),
      ),
    ).toBe("/remote%20host/thread%2F1?artifact=artifact%20one");
  });
});
