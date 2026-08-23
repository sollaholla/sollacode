import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ThreadArtifactId,
  ThreadArtifactKey,
  ThreadId,
  type ThreadArtifactStreamItem,
} from "@t3tools/contracts";
import { assert, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import Migration054 from "../persistence/Migrations/054_ThreadArtifacts.ts";
import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";
import { decodeArtifactManifest } from "./ArtifactManifest.ts";
import {
  sanitizeArtifactIconSvg,
  ThreadArtifactService,
  layer as ThreadArtifactServiceLive,
} from "./ThreadArtifactService.ts";

const configLayer = ServerConfig.ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-thread-artifact-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));
const infrastructure = Layer.mergeAll(
  NodeSqliteClient.layerMemory(),
  configLayer,
  NodeServices.layer,
);
const testSchema = Layer.effectDiscard(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`PRAGMA foreign_keys = ON`;
    yield* sql`
      CREATE TABLE projection_threads (
        thread_id TEXT PRIMARY KEY,
        deleted_at TEXT
      )
    `;
    yield* Migration054;
  }),
).pipe(Layer.provideMerge(infrastructure));
const testLayer = ThreadArtifactServiceLive.pipe(Layer.provideMerge(testSchema));

const encoder = new TextEncoder();
const key = (value: string) => ThreadArtifactKey.make(value);

const insertThread = (threadId: ReturnType<typeof ThreadId.make>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO projection_threads (thread_id, deleted_at)
      VALUES (${threadId}, NULL)
    `;
  });

describe("sanitizeArtifactIconSvg", () => {
  it("keeps the safe icon subset and strips unsafe attributes", () => {
    expect(
      sanitizeArtifactIconSvg(
        '<svg viewBox="0 0 24 24" onclick="alert(1)"><path d="M1 1h2" fill="#fff" /></svg>',
      ),
    ).toBe(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M1 1h2" fill="#fff"></path></svg>',
    );
  });

  it("rejects executable elements, doctypes, and excessive node counts", () => {
    expect(sanitizeArtifactIconSvg("<svg><script>alert(1)</script></svg>")).toBeNull();
    expect(sanitizeArtifactIconSvg('<!DOCTYPE svg><svg viewBox="0 0 1 1"></svg>')).toBeNull();
    expect(
      sanitizeArtifactIconSvg(`<svg>${"<g>".repeat(65)}${"</g>".repeat(65)}</svg>`),
    ).toBeNull();
  });
});

const layer = it.layer(testLayer);

layer("ThreadArtifactService", (it) => {
  it.effect("revises by stable thread-local key and supports reversible archive", () =>
    Effect.gen(function* () {
      const service = yield* ThreadArtifactService;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const config = yield* ServerConfig.ServerConfig;
      const threadId = ThreadId.make("thread-artifact-stable-key");
      yield* insertThread(threadId);

      const first = yield* service.publish({
        threadId,
        key: key("release-notes"),
        title: "Release notes",
        description: "Remote-ready notes",
        kind: "web",
        entryPath: "site/index.html",
        files: [
          {
            path: "site/index.html",
            contentType: "text/html",
            bytes: encoder.encode(
              '<link rel="stylesheet" href="styles/app.css"><script src="scripts/app.js"></script>',
            ),
          },
          {
            path: "site/styles/app.css",
            contentType: "text/css",
            bytes: encoder.encode("body { color: rebeccapurple; }"),
          },
          {
            path: "site/scripts/app.js",
            contentType: "text/javascript",
            bytes: encoder.encode("document.body.dataset.ready = 'true';"),
          },
        ],
        iconSvg: "<svg><script>alert(1)</script></svg>",
      });

      assert.strictEqual(first.artifact.key, "release-notes");
      assert.strictEqual(first.artifact.currentRevision, 1);
      assert.strictEqual(first.revision.iconSource, "generated");
      const firstIconPath = path.join(
        config.artifactsDir,
        first.artifact.artifactId,
        "revisions",
        "1",
        "icon.svg",
      );
      const firstIcon = yield* fileSystem.readFileString(firstIconPath);
      expect(firstIcon).toContain("<title>R web artifact</title>");
      expect(firstIcon).toContain("hsl(");
      expect(firstIcon).not.toContain("script");

      const second = yield* service.publish({
        threadId,
        key: key("release-notes"),
        title: "Release notes v2",
        kind: "web",
        entryPath: "site/index.html",
        files: [
          {
            path: "site/index.html",
            contentType: "text/html",
            bytes: encoder.encode("<main>revision two</main>"),
          },
        ],
        iconSvg:
          '<svg viewBox="0 0 24 24" onclick="bad()"><circle cx="12" cy="12" r="8" fill="#123456" /></svg>',
      });

      assert.strictEqual(second.artifact.artifactId, first.artifact.artifactId);
      assert.strictEqual(second.artifact.currentRevision, 2);
      assert.deepStrictEqual(
        second.revisions.map((revision) => revision.revision),
        [2, 1],
      );
      assert.strictEqual(second.revision.iconSource, "provided");
      const secondIcon = yield* fileSystem.readFileString(
        path.join(config.artifactsDir, second.artifact.artifactId, "revisions", "2", "icon.svg"),
      );
      expect(secondIcon).not.toContain("onclick");
      expect(secondIcon).toContain("#123456");

      const manifest = yield* fileSystem.readFileString(
        path.join(
          config.artifactsDir,
          second.artifact.artifactId,
          "revisions",
          "2",
          ".manifest.json",
        ),
      );
      expect(Option.getOrThrow(decodeArtifactManifest(manifest))).toMatchObject({
        version: 1,
        entryPath: "site/index.html",
        files: [{ path: "site/index.html", contentType: "text/html" }],
      });

      const archived = yield* service.setArchived({
        threadId,
        artifactId: first.artifact.artifactId,
        archived: true,
      });
      assert.isNotNull(archived.artifact.archivedAt);
      assert.lengthOf((yield* service.list({ threadId })).artifacts, 0);
      assert.lengthOf((yield* service.list({ threadId, includeArchived: true })).artifacts, 1);

      const restored = yield* service.setArchived({
        threadId,
        artifactId: first.artifact.artifactId,
        archived: false,
      });
      assert.isNull(restored.artifact.archivedAt);
      assert.lengthOf((yield* service.list({ threadId })).artifacts, 1);
    }),
  );

  it.effect(
    "deletes one artifact irreversibly — rows and bytes — without touching its neighbours",
    () =>
      Effect.gen(function* () {
        const service = yield* ThreadArtifactService;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const config = yield* ServerConfig.ServerConfig;
        const threadId = ThreadId.make("thread-artifact-delete");
        yield* insertThread(threadId);

        const publish = (artifactKey: string, body: string) =>
          service.publish({
            threadId,
            key: key(artifactKey),
            title: `Artifact ${artifactKey}`,
            kind: "markdown",
            entryPath: "notes.md",
            files: [
              { path: "notes.md", contentType: "text/markdown", bytes: encoder.encode(body) },
            ],
          });
        const doomed = yield* publish("doomed", "first revision");
        yield* publish("doomed", "second revision");
        const survivor = yield* publish("survivor", "still here");

        const doomedDirectory = path.join(config.artifactsDir, doomed.artifact.artifactId);
        assert.isTrue(yield* fileSystem.exists(doomedDirectory));

        const deleted = yield* service.deleteArtifact({
          threadId,
          artifactId: doomed.artifact.artifactId,
        });
        assert.strictEqual(deleted.artifactId, doomed.artifact.artifactId);
        assert.isFalse(yield* fileSystem.exists(doomedDirectory));

        // Gone from every view — including the archived one — and a second
        // delete reports not-found instead of pretending it worked.
        const remaining = yield* service.list({ threadId, includeArchived: true });
        assert.deepStrictEqual(
          remaining.artifacts.map((entry) => entry.artifact.artifactId),
          [survivor.artifact.artifactId],
        );
        const refetch = yield* service
          .get({ threadId, artifactId: doomed.artifact.artifactId })
          .pipe(Effect.flip);
        assert.strictEqual(refetch._tag, "ThreadArtifactNotFoundError");
        const again = yield* service
          .deleteArtifact({ threadId, artifactId: doomed.artifact.artifactId })
          .pipe(Effect.flip);
        assert.strictEqual(again._tag, "ThreadArtifactNotFoundError");

        const survivorBytes = yield* fileSystem.readFileString(
          path.join(
            config.artifactsDir,
            survivor.artifact.artifactId,
            "revisions",
            "1",
            "notes.md",
          ),
        );
        assert.strictEqual(survivorBytes, "still here");
      }),
  );

  it.effect("rejects traversal, forged MIME types, module bundles, and deleted owners", () =>
    Effect.gen(function* () {
      const service = yield* ThreadArtifactService;
      const sql = yield* SqlClient.SqlClient;
      const threadId = ThreadId.make("thread-artifact-confinement");
      yield* insertThread(threadId);

      const traversal = yield* service
        .publish({
          threadId,
          key: key("traversal"),
          title: "Traversal",
          kind: "markdown",
          entryPath: "../private.md",
          files: [
            {
              path: "../private.md",
              contentType: "text/markdown",
              bytes: encoder.encode("private"),
            },
          ],
        })
        .pipe(Effect.flip);
      assert.strictEqual(traversal._tag, "ThreadArtifactInvalidInputError");

      const forgedMime = yield* service
        .publish({
          threadId,
          key: key("forged-mime"),
          title: "Forged MIME",
          kind: "image",
          entryPath: "preview.png",
          files: [
            {
              path: "preview.png",
              contentType: "image/png",
              bytes: encoder.encode("not a png"),
            },
          ],
        })
        .pipe(Effect.flip);
      assert.strictEqual(forgedMime._tag, "ThreadArtifactInvalidInputError");

      const invalidJson = yield* service
        .publish({
          threadId,
          key: key("invalid-json"),
          title: "Invalid JSON",
          kind: "structured",
          entryPath: "data.json",
          files: [
            {
              path: "data.json",
              contentType: "application/json",
              bytes: encoder.encode("{not-json}"),
            },
          ],
        })
        .pipe(Effect.flip);
      assert.strictEqual(invalidJson._tag, "ThreadArtifactInvalidInputError");

      const invalidUtf8 = yield* service
        .publish({
          threadId,
          key: key("invalid-utf8"),
          title: "Invalid UTF-8",
          kind: "markdown",
          entryPath: "README.md",
          files: [
            {
              path: "README.md",
              contentType: "text/markdown",
              bytes: new Uint8Array([0xc3, 0x28]),
            },
          ],
        })
        .pipe(Effect.flip);
      assert.strictEqual(invalidUtf8._tag, "ThreadArtifactInvalidInputError");

      const moduleBundle = yield* service
        .publish({
          threadId,
          key: key("module-bundle"),
          title: "Module bundle",
          kind: "web",
          entryPath: "index.html",
          files: [
            {
              path: "index.html",
              contentType: "text/html",
              bytes: encoder.encode('<script type="module" src="app.js"></script>'),
            },
            {
              path: "app.js",
              contentType: "text/javascript",
              bytes: encoder.encode("export const ready = true;"),
            },
          ],
        })
        .pipe(Effect.flip);
      assert.strictEqual(moduleBundle._tag, "ThreadArtifactInvalidInputError");

      yield* sql`
        UPDATE projection_threads SET deleted_at = '2026-08-21T00:00:00.000Z'
        WHERE thread_id = ${threadId}
      `;
      const deletedOwner = yield* service.list({ threadId }).pipe(Effect.flip);
      assert.strictEqual(deletedOwner._tag, "ThreadArtifactNotFoundError");
    }),
  );

  it.effect("publishes bounded live snapshots to connected clients", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const service = yield* ThreadArtifactService;
        const threadId = ThreadId.make("thread-artifact-subscription");
        yield* insertThread(threadId);

        const updates = yield* Queue.unbounded<ThreadArtifactStreamItem>();
        yield* service.subscribe({ threadId }).pipe(
          Stream.runForEach((item) => Queue.offer(updates, item)),
          Effect.forkScoped,
        );
        const initial = yield* Queue.take(updates);
        assert.lengthOf(initial.snapshot.artifacts, 0);

        yield* service.publish({
          threadId,
          key: key("live-preview"),
          title: "Live preview",
          kind: "markdown",
          entryPath: "README.md",
          files: [
            {
              path: "README.md",
              contentType: "text/markdown",
              bytes: encoder.encode("# Live"),
            },
          ],
        });
        const published = yield* Queue.take(updates);
        assert.strictEqual(published.snapshot.artifacts[0]?.artifact.key, "live-preview");
        assert.strictEqual(published.snapshot.artifacts[0]?.revision.revision, 1);
      }),
    ),
  );

  it.effect("does not let an explicit id retarget another stable key", () =>
    Effect.gen(function* () {
      const service = yield* ThreadArtifactService;
      const threadId = ThreadId.make("thread-artifact-key-id-conflict");
      yield* insertThread(threadId);
      const first = yield* service.publish({
        threadId,
        key: key("first"),
        title: "First",
        kind: "markdown",
        entryPath: "first.md",
        files: [
          {
            path: "first.md",
            contentType: "text/markdown",
            bytes: encoder.encode("first"),
          },
        ],
      });
      const error = yield* service
        .publish({
          threadId,
          artifactId: ThreadArtifactId.make(first.artifact.artifactId),
          key: key("second"),
          title: "Second",
          kind: "markdown",
          entryPath: "second.md",
          files: [
            {
              path: "second.md",
              contentType: "text/markdown",
              bytes: encoder.encode("second"),
            },
          ],
        })
        .pipe(Effect.flip);
      assert.strictEqual(error._tag, "ThreadArtifactInvalidInputError");
    }),
  );

  it.effect("removes immutable bytes and metadata only for deleted-thread cleanup", () =>
    Effect.gen(function* () {
      const service = yield* ThreadArtifactService;
      const sql = yield* SqlClient.SqlClient;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const config = yield* ServerConfig.ServerConfig;
      const threadId = ThreadId.make("thread-artifact-deletion-cleanup");
      yield* insertThread(threadId);

      const first = yield* service.publish({
        threadId,
        key: key("cleanup"),
        title: "Cleanup",
        kind: "markdown",
        entryPath: "README.md",
        files: [
          {
            path: "README.md",
            contentType: "text/markdown",
            bytes: encoder.encode("revision one"),
          },
        ],
      });
      yield* service.publish({
        threadId,
        key: key("cleanup"),
        title: "Cleanup",
        kind: "markdown",
        entryPath: "README.md",
        files: [
          {
            path: "README.md",
            contentType: "text/markdown",
            bytes: encoder.encode("revision two"),
          },
        ],
      });
      const artifactDirectory = path.join(config.artifactsDir, first.artifact.artifactId);
      assert.isTrue(yield* fileSystem.exists(artifactDirectory));

      yield* sql`
        UPDATE projection_threads SET deleted_at = '2026-08-21T00:00:00.000Z'
        WHERE thread_id = ${threadId}
      `;
      assert.deepStrictEqual(yield* service.cleanupDeletedThread(threadId), {
        artifactCount: 1,
        revisionCount: 2,
      });
      assert.isFalse(yield* fileSystem.exists(artifactDirectory));
      const remaining = yield* sql<{ readonly value: number }>`
        SELECT COUNT(*) AS value FROM thread_artifacts WHERE thread_id = ${threadId}
      `;
      assert.strictEqual(remaining[0]?.value, 0);
      assert.deepStrictEqual(yield* service.cleanupDeletedThread(threadId), {
        artifactCount: 0,
        revisionCount: 0,
      });
    }),
  );
});
