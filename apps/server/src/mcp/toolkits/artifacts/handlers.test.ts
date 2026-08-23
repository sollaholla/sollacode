import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EnvironmentId,
  type IsoDateTime,
  ProviderInstanceId,
  ThreadArtifactId,
  ThreadArtifactKey,
  type ThreadArtifactDetail,
  type ThreadArtifactListInput,
  ThreadId,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";

import {
  ThreadArtifactService,
  type ThreadArtifactPublishInput,
} from "../../../artifacts/ThreadArtifactService.ts";
import * as ServerSecretStore from "../../../auth/ServerSecretStore.ts";
import * as ServerConfig from "../../../config.ts";
import * as WorkspacePaths from "../../../workspace/WorkspacePaths.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as ProjectionSnapshotQuery from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { handleThreadArtifact } from "./handlers.ts";
import type { ThreadArtifactToolInput } from "./types.ts";

const callerThreadId = ThreadId.make("thread-artifact-caller");
const otherThreadId = ThreadId.make("thread-artifact-other");
const environmentId = EnvironmentId.make("environment-artifact-test");
const artifactId = ThreadArtifactId.make("artifact-release-notes");
const artifactKey = ThreadArtifactKey.make("release-notes");
const createdAt = "2026-08-21T20:00:00.000Z" as IsoDateTime;

const detail: ThreadArtifactDetail = {
  artifact: {
    artifactId,
    threadId: callerThreadId,
    key: artifactKey,
    title: "Release notes",
    description: null,
    kind: "web",
    currentRevision: 1,
    archivedAt: null,
    createdAt,
    updatedAt: createdAt,
  },
  revision: {
    artifactId,
    revision: 1,
    entryPath: "site/index.html",
    contentType: "text/html",
    byteLength: 31,
    fileCount: 1,
    iconSource: "generated",
    createdAt,
  },
  revisions: [
    {
      artifactId,
      revision: 1,
      entryPath: "site/index.html",
      contentType: "text/html",
      byteLength: 31,
      fileCount: 1,
      iconSource: "generated",
      createdAt,
    },
  ],
  entryResource: {
    _tag: "artifact-revision",
    threadId: callerThreadId,
    artifactId,
    revision: 1,
    path: "site/index.html",
  },
  iconResource: {
    _tag: "artifact-icon",
    threadId: callerThreadId,
    artifactId,
    revision: 1,
  },
};

const configLayer = ServerConfig.ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-artifact-handler-test-",
});
const testLayer = Layer.mergeAll(
  configLayer,
  WorkspacePaths.layer,
  ServerSecretStore.layer.pipe(Layer.provide(configLayer)),
).pipe(Layer.provideMerge(NodeServices.layer));

const invocation = (
  capabilities = new Set<McpInvocationContext.McpCapability>(["artifacts"]),
): McpInvocationContext.McpInvocationScope => ({
  environmentId,
  threadId: callerThreadId,
  providerSessionId: "provider-session-artifact-test",
  providerInstanceId: ProviderInstanceId.make("codex"),
  capabilities,
  issuedAt: 1,
});

const makeHarness = () => {
  const listInputs: ThreadArtifactListInput[] = [];
  const publishInputs: ThreadArtifactPublishInput[] = [];
  const service = ThreadArtifactService.of({
    list: (input) =>
      Effect.sync(() => {
        listInputs.push(input);
        return { threadId: input.threadId, artifacts: [] };
      }),
    get: () => Effect.die("unused"),
    publish: (input) =>
      Effect.sync(() => {
        publishInputs.push(input);
        return detail;
      }),
    setArchived: () => Effect.die("unused"),
    deleteArtifact: () => Effect.die("unused"),
    subscribe: () => Stream.die("unused"),
    cleanupDeletedThread: () => Effect.die("unused"),
  });
  return { service, listInputs, publishInputs };
};

/**
 * Thread shells the projection mock serves. Empty by default: the caller is an
 * ordinary thread and artifact operations stay on it. Side-chat tests install
 * a shell claiming a parent.
 */
const projectionsWith = (
  shellsById: ReadonlyMap<string, { isSideChat?: boolean; sideChatParentThreadId?: string }>,
) =>
  Layer.mock(ProjectionSnapshotQuery.ProjectionSnapshotQuery)({
    getThreadShellById: (threadId: string) =>
      Effect.succeed(
        shellsById.has(threadId) ? Option.some(shellsById.get(threadId) as never) : Option.none(),
      ),
  });

const runAs = <A, E, R>(
  effect: Effect.Effect<
    A,
    E,
    | R
    | ThreadArtifactService
    | McpInvocationContext.McpInvocationContext
    | ProjectionSnapshotQuery.ProjectionSnapshotQuery
  >,
  service: ThreadArtifactService["Service"],
  capabilities?: Set<McpInvocationContext.McpCapability>,
  shellsById: ReadonlyMap<
    string,
    { isSideChat?: boolean; sideChatParentThreadId?: string }
  > = new Map(),
) =>
  effect.pipe(
    Effect.provideService(McpInvocationContext.McpInvocationContext, invocation(capabilities)),
    Effect.provideService(ThreadArtifactService, service),
    Effect.provide(projectionsWith(shellsById)),
  );

it.layer(testLayer)("thread artifact toolkit", (it) => {
  it.effect("rejects credentials without the artifacts capability before service access", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      const error = yield* Effect.flip(
        runAs(handleThreadArtifact({ action: "list" }), harness.service, new Set()),
      );

      expect(error._tag).toBe("ThreadArtifactInvalidInputError");
      if (error._tag !== "ThreadArtifactInvalidInputError") {
        return yield* Effect.die(`Unexpected artifact error: ${error._tag}`);
      }
      expect(error.field).toBe("capability");
      expect(harness.listInputs).toEqual([]);
    }),
  );

  it.effect("binds list access to the credential thread even when input carries another id", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      const input = {
        action: "list",
        includeArchived: true,
        threadId: otherThreadId,
      } as ThreadArtifactToolInput;

      const result = yield* runAs(handleThreadArtifact(input), harness.service);

      if (result.action !== "list") {
        return yield* Effect.die(`Unexpected artifact action: ${result.action}`);
      }
      expect(result.list?.threadId).toBe(callerThreadId);
      expect(harness.listInputs).toEqual([{ threadId: callerThreadId, includeArchived: true }]);
    }),
  );

  it.effect("publishes for the credential thread and returns remote-safe artifact addresses", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const config = yield* ServerConfig.ServerConfig;
      const revisionRoot = path.join(config.artifactsDir, artifactId, "revisions", "1");
      yield* fileSystem.makeDirectory(path.join(revisionRoot, "site"), { recursive: true });
      yield* fileSystem.writeFileString(
        path.join(revisionRoot, "site", "index.html"),
        "<h1>Release notes</h1>",
      );
      yield* fileSystem.writeFileString(
        path.join(revisionRoot, "icon.svg"),
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"></svg>',
      );

      const harness = makeHarness();
      const result = yield* runAs(
        handleThreadArtifact({
          action: "publish",
          key: artifactKey,
          title: "Release notes",
          kind: "web",
          entryPath: "site/index.html",
          files: [
            {
              path: "site/index.html",
              contentType: "text/html",
              text: "<h1>Release notes</h1>",
            },
          ],
        }),
        harness.service,
      );

      if (result.action !== "publish") {
        return yield* Effect.die(`Unexpected artifact action: ${result.action}`);
      }
      expect(harness.publishInputs).toHaveLength(1);
      expect(harness.publishInputs[0]?.threadId).toBe(callerThreadId);
      expect(harness.publishInputs[0]?.key).toBe(artifactKey);
      expect(new TextDecoder().decode(harness.publishInputs[0]?.files[0]?.bytes)).toBe(
        "<h1>Release notes</h1>",
      );
      expect(result.contentUrl).toMatch(
        /^\/api\/assets\/[A-Za-z0-9_-]+[.][A-Za-z0-9_-]+\/site\/index[.]html$/u,
      );
      expect(result.iconUrl).toMatch(
        /^\/api\/assets\/[A-Za-z0-9_-]+[.][A-Za-z0-9_-]+\/icon[.]svg$/u,
      );
      expect(result.contentUrl).not.toContain("localhost");
      expect(result.openPath).toBe(
        "/environment-artifact-test/thread-artifact-caller?artifact=artifact-release-notes",
      );
      expect(result.deepLink).toBe(result.openPath);
      expect(result.resourceUri).toBe(
        "t3-artifact://environment-artifact-test/thread-artifact-caller/artifact-release-notes/revisions/1/site/index.html",
      );
      expect(result.expiresAt).toBeGreaterThan(0);
    }),
  );

  it.effect("a connected side chat manages its parent thread's artifacts", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      const shells = new Map([
        [callerThreadId as string, { isSideChat: true, sideChatParentThreadId: otherThreadId }],
        [otherThreadId as string, {}],
      ]);
      yield* runAs(handleThreadArtifact({ action: "list" }), harness.service, undefined, shells);
      expect(harness.listInputs.map((input) => input.threadId)).toEqual([otherThreadId]);

      const result = yield* runAs(
        handleThreadArtifact({
          action: "publish",
          key: artifactKey,
          title: "Release notes",
          kind: "web",
          entryPath: "site/index.html",
          files: [
            { path: "site/index.html", contentType: "text/html", text: "<html>hello</html>" },
          ],
        }),
        harness.service,
        undefined,
        shells,
      );
      expect(harness.publishInputs.map((input) => input.threadId)).toEqual([otherThreadId]);
      if (result.action !== "publish") {
        return yield* Effect.die(`Unexpected artifact action: ${result.action}`);
      }
      // Addresses point at the artifact's owner thread, not the side chat.
      expect(result.openPath).toBe(
        "/environment-artifact-test/thread-artifact-other?artifact=artifact-release-notes",
      );
    }),
  );

  it.effect("a side chat whose parent is gone falls back to its own artifacts", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      // The shell claims a parent, but no parent shell exists any more.
      const shells = new Map([
        [callerThreadId as string, { isSideChat: true, sideChatParentThreadId: otherThreadId }],
      ]);
      yield* runAs(handleThreadArtifact({ action: "list" }), harness.service, undefined, shells);
      expect(harness.listInputs.map((input) => input.threadId)).toEqual([callerThreadId]);
    }),
  );
});
