// @effect-diagnostics nodeBuiltinImport:off - The download test needs a real
// temporary directory, because the handler under test writes to disk
// synchronously inside Electron's will-download callback.
import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import { beforeEach, vi } from "vite-plus/test";

const { fromPartition, sessions } = vi.hoisted(() => ({
  fromPartition: vi.fn(),
  sessions: new Map<
    string,
    {
      readonly clearCache: ReturnType<typeof vi.fn>;
      readonly clearStorageData: ReturnType<typeof vi.fn>;
      readonly getUserAgent: ReturnType<typeof vi.fn>;
      readonly on: ReturnType<typeof vi.fn>;
      readonly setPermissionRequestHandler: ReturnType<typeof vi.fn>;
      readonly setPermissionCheckHandler: ReturnType<typeof vi.fn>;
      readonly setUserAgent: ReturnType<typeof vi.fn>;
    }
  >(),
}));

vi.mock("electron", () => ({
  session: {
    fromPartition,
  },
  // Reporting a finished download raises an OS notification. Saying the
  // platform has none keeps these tests off the real notification centre.
  Notification: { isSupported: () => false },
}));

import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as BrowserSession from "./BrowserSession.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";

const testHome = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-browser-session-"));

const environmentLayer = DesktopEnvironment.layer({
  dirname: "/repo/apps/desktop/src",
  homeDirectory: testHome,
  platform: "darwin",
  processArch: "arm64",
  appVersion: "1.2.3",
  appPath: "/repo",
  isPackaged: true,
  resourcesPath: "/missing/resources",
  runningUnderArm64Translation: false,
}).pipe(Layer.provide(NodeServices.layer));

const layer = BrowserSession.layer.pipe(
  Layer.provide(environmentLayer),
  Layer.provide(NodeServices.layer),
);

/**
 * The parts of Electron's `DownloadItem` the will-download handler touches.
 *
 * `finish` fires the item's own `done` listener, which is how the handler
 * learns the bytes landed — there is no other way to reach that branch
 * without a real transfer.
 */
function makeDownloadItem(fileName: string, url: string) {
  let savePath = "";
  let done: ((event: unknown, state: string) => void) | null = null;
  return {
    getFilename: () => fileName,
    getURL: () => url,
    setSavePath: (value: string) => {
      savePath = value;
    },
    once: (event: string, listener: (event: unknown, state: string) => void) => {
      if (event === "done") done = listener;
    },
    cancel: () => undefined,
    savedTo: () => savePath,
    finish: (state: string) => done?.({}, state),
  };
}

const registerWillDownload = Effect.fn(function* (
  browserSessions: typeof BrowserSession.BrowserSession.Service,
  scope: string,
) {
  const partition = yield* browserSessions.getPartition(scope);
  yield* browserSessions.getSession(scope);
  const browserSession = sessions.get(partition);
  if (!browserSession) throw new Error("Expected a session for the derived partition");
  const registration = browserSession.on.mock.calls.find(
    ([event]: ReadonlyArray<unknown>) => event === "will-download",
  );
  if (!registration) throw new Error("Expected a will-download registration");
  const handler = registration[1] as (event: unknown, item: unknown, guest: unknown) => void;
  return (item: ReturnType<typeof makeDownloadItem>) => handler({}, item, { id: 7 });
});

describe("BrowserSession", () => {
  beforeEach(() => {
    sessions.clear();
    fromPartition.mockReset();
    fromPartition.mockImplementation((partition: string) => {
      const browserSession = {
        clearCache: vi.fn(() => Promise.resolve()),
        clearStorageData: vi.fn(() => Promise.resolve()),
        getUserAgent: vi.fn(() => "Mozilla/5.0 Electron/41.5.0 t3code/0.0.27"),
        on: vi.fn(),
        setPermissionRequestHandler: vi.fn(),
        setPermissionCheckHandler: vi.fn(),
        setUserAgent: vi.fn(),
      };
      sessions.set(partition, browserSession);
      return browserSession;
    });
  });

  it.effect("derives deterministic partitions and memoizes sessions", () =>
    Effect.gen(function* () {
      const browserSessions = yield* BrowserSession.BrowserSession;

      const partition = yield* browserSessions.getPartition("scope-a");
      const first = yield* browserSessions.getSession("scope-a");
      const second = yield* browserSessions.getSession("scope-a");

      assert.strictEqual(partition, "persist:t3code-preview-f051bb2c68cb7b2fe969");
      assert.strictEqual(first, second);
      assert.strictEqual(fromPartition.mock.calls.length, 1);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("preserves Electron's native user agent for browser integrity checks", () =>
    Effect.gen(function* () {
      const browserSessions = yield* BrowserSession.BrowserSession;
      const partition = yield* browserSessions.getPartition("scope-a");
      const browserSession = yield* browserSessions.getSession("scope-a");

      assert.strictEqual(browserSession as unknown, sessions.get(partition));
      assert.strictEqual(sessions.get(partition)?.getUserAgent.mock.calls.length, 0);
      assert.strictEqual(sessions.get(partition)?.setUserAgent.mock.calls.length, 0);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("grants clipboard-sanitized-write through both the request and check handlers", () =>
    Effect.gen(function* () {
      const browserSessions = yield* BrowserSession.BrowserSession;
      const partition = yield* browserSessions.getPartition("scope-a");
      yield* browserSessions.getSession("scope-a");

      const browserSession = sessions.get(partition);
      assert.isDefined(browserSession);

      const requestHandler = browserSession.setPermissionRequestHandler.mock.calls[0]?.[0];
      const checkHandler = browserSession.setPermissionCheckHandler.mock.calls[0]?.[0];
      assert.isFunction(requestHandler);
      assert.isFunction(checkHandler);

      const requestAllows = (permission: string): boolean => {
        let granted: boolean | undefined;
        requestHandler(null, permission, (value: boolean) => {
          granted = value;
        });
        assert.isDefined(granted);
        return granted;
      };

      for (const permission of [
        "clipboard-read",
        "clipboard-sanitized-write",
        "notifications",
        "geolocation",
      ]) {
        assert.isTrue(requestAllows(permission), `request handler should allow ${permission}`);
        assert.isTrue(
          checkHandler(null, permission) as boolean,
          `check handler should allow ${permission}`,
        );
      }

      // `clipboard-write` is not a real Electron permission — the async write API
      // uses `clipboard-sanitized-write` — so the stale name must not be granted,
      // and unrelated permissions stay denied.
      for (const permission of ["clipboard-write", "midi"]) {
        assert.isFalse(requestAllows(permission), `request handler should deny ${permission}`);
        assert.isFalse(
          checkHandler(null, permission) as boolean,
          `check handler should deny ${permission}`,
        );
      }
    }).pipe(Effect.provide(layer)),
  );

  it.effect("holds a new site's download in staging until the user allows it", () =>
    Effect.gen(function* () {
      // Two things are being protected at once. A save panel means a download
      // only completes if a human clicks Save, so a background agent hung on
      // it — hence the path. But suppressing the panel also removed the only
      // moment a human could refuse, so the first file from a domain waits in
      // a staging folder instead of landing in the workspace.
      const browserSessions = yield* BrowserSession.BrowserSession;
      const downloads: Array<{ readonly webContentsId: number; readonly path: string }> = [];
      browserSessions.onDownload((webContentsId, download) => {
        downloads.push({ webContentsId, path: download.path });
      });
      const approvalEvents: Array<BrowserSession.DownloadApprovalEvent> = [];
      browserSessions.onDownloadApproval((_webContentsId, event) => {
        approvalEvents.push(event);
      });
      const willDownload = yield* registerWillDownload(browserSessions, "scope-a");

      const held = makeDownloadItem("moose-render.mp4", "https://grok.com/f/moose-render.mp4");
      willDownload(held);

      const stagedTo = held.savedTo();
      assert.isTrue(
        stagedTo.endsWith(NodePath.join(".pending-approval", "moose-render.mp4")),
        stagedTo,
      );
      const pending = approvalEvents[0];
      assert.strictEqual(pending?.kind, "pending");
      if (pending?.kind !== "pending") throw new Error("Expected a pending approval");
      assert.strictEqual(pending.approval.domain, "grok.com");
      assert.strictEqual(pending.approval.fileName, "moose-render.mp4");

      // The transfer finishes while the question is still on screen. Nothing
      // may be reported as downloaded yet: it is not in the workspace.
      NodeFS.writeFileSync(stagedTo, "bytes");
      held.finish("completed");
      assert.strictEqual(downloads.length, 0);
      assert.isTrue(NodeFS.existsSync(stagedTo));

      browserSessions.answerDownloadApproval(pending.approval.id, "allow-domain");

      assert.strictEqual(downloads.length, 1);
      const landedAt = downloads[0]?.path ?? "";
      assert.isTrue(landedAt.endsWith(NodePath.join("downloads", "moose-render.mp4")), landedAt);
      assert.isTrue(NodeFS.existsSync(landedAt));
      assert.isFalse(NodeFS.existsSync(stagedTo));
      assert.deepStrictEqual(approvalEvents.at(-1), {
        kind: "settled",
        id: pending.approval.id,
      });

      // The answer was about the site, so the next file from it is not asked
      // about again and goes straight where it belongs.
      const trusted = makeDownloadItem("moose-clip.mp4", "https://grok.com/f/moose-clip.mp4");
      willDownload(trusted);
      const trustedPath = trusted.savedTo();
      assert.isTrue(
        trustedPath.endsWith(NodePath.join("downloads", "moose-clip.mp4")),
        trustedPath,
      );
      assert.strictEqual(approvalEvents.length, 2);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("clears the fallback directory's abandoned holds on start-up", () =>
    Effect.gen(function* () {
      // A tab with no workspace of its own stages into the app's own downloads
      // folder, which nothing ever nominates — so without a start-up sweep
      // those bytes outlive the run that fetched them with nothing to catch
      // them later.
      const environment = yield* DesktopEnvironment.DesktopEnvironment;
      const fallbackStaging = NodePath.join(
        environment.browserArtifactsDir,
        "downloads",
        ".pending-approval",
      );
      NodeFS.mkdirSync(fallbackStaging, { recursive: true });
      const abandoned = NodePath.join(fallbackStaging, "left-by-a-crash.bin");
      NodeFS.writeFileSync(abandoned, "bytes");

      // Building the service is what runs the sweep, so it has to be built
      // after the abandoned file exists.
      yield* Effect.provide(BrowserSession.BrowserSession, layer);

      assert.isFalse(NodeFS.existsSync(abandoned));
      // Only the environment is provided from outside: the service under test
      // has to be built after the abandoned file exists, or the sweep runs
      // before there is anything to sweep.
    }).pipe(Effect.provide(environmentLayer)),
  );

  it.effect("clears files a crash left staged, but not one still being decided", () =>
    Effect.gen(function* () {
      // Bytes staged for a question nobody ever answered are bytes the user
      // never allowed. A force quit must not leave them in the workspace.
      const browserSessions = yield* BrowserSession.BrowserSession;
      const workspace = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-sweep-"));
      const staging = NodePath.join(workspace, ".pending-approval");
      NodeFS.mkdirSync(staging, { recursive: true });
      const orphan = NodePath.join(staging, "left-behind.bin");
      NodeFS.writeFileSync(orphan, "bytes");

      yield* browserSessions.setDownloadDirectory("scope-sweep", workspace);
      assert.isFalse(NodeFS.existsSync(orphan));

      // A hold that is still on screen owns its staged file, so nominating the
      // same workspace again must leave it alone.
      const willDownload = yield* registerWillDownload(browserSessions, "scope-sweep");
      const held = makeDownloadItem("in-flight.bin", "https://grok.com/in-flight.bin");
      willDownload(held);
      const stagedTo = held.savedTo();
      NodeFS.writeFileSync(stagedTo, "bytes");

      yield* browserSessions.setDownloadDirectory("scope-sweep", workspace);
      assert.isTrue(NodeFS.existsSync(stagedTo));
    }).pipe(Effect.provide(layer)),
  );

  it.effect("keeps nothing on disk when the user denies a download", () =>
    Effect.gen(function* () {
      const browserSessions = yield* BrowserSession.BrowserSession;
      const downloads: Array<string> = [];
      browserSessions.onDownload((_webContentsId, download) => {
        downloads.push(download.path);
      });
      const approvalEvents: Array<BrowserSession.DownloadApprovalEvent> = [];
      browserSessions.onDownloadApproval((_webContentsId, event) => {
        approvalEvents.push(event);
      });
      const willDownload = yield* registerWillDownload(browserSessions, "scope-deny");

      const held = makeDownloadItem("payload.bin", "https://evil.test/payload.bin");
      willDownload(held);
      const stagedTo = held.savedTo();
      NodeFS.writeFileSync(stagedTo, "bytes");
      held.finish("completed");

      const pending = approvalEvents[0];
      if (pending?.kind !== "pending") throw new Error("Expected a pending approval");
      browserSessions.answerDownloadApproval(pending.approval.id, "deny");

      assert.strictEqual(downloads.length, 0);
      assert.isFalse(NodeFS.existsSync(stagedTo));
      // And a denial teaches the session nothing: the next file asks again.
      const again = makeDownloadItem("payload.bin", "https://evil.test/payload.bin");
      willDownload(again);
      assert.strictEqual(approvalEvents.filter((event) => event.kind === "pending").length, 2);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("preserves partition scope and the platform failure chain", () => {
    const nativeCause = new Error("native digest failed");
    const platformCause = PlatformError.systemError({
      _tag: "Unknown",
      module: "Crypto",
      method: "digest",
      cause: nativeCause,
    });
    const failingCryptoLayer = Layer.succeed(
      Crypto.Crypto,
      Crypto.make({
        randomBytes: (size) => new Uint8Array(size),
        digest: () => Effect.fail(platformCause),
      }),
    );

    return Effect.gen(function* () {
      const browserSessions = yield* BrowserSession.BrowserSession;
      const error = yield* browserSessions.getPartition("environment-a").pipe(Effect.flip);

      assert.instanceOf(error, BrowserSession.BrowserSessionPartitionDerivationError);
      assert.isTrue(BrowserSession.isBrowserSessionGetSessionError(error));
      assert.isTrue(BrowserSession.isBrowserSessionError(error));
      assert.equal(error.scope, "environment-a");
      assert.strictEqual(error.cause, platformCause);
      assert.strictEqual(error.cause.reason.cause, nativeCause);
      assert.equal(
        error.message,
        "Failed to derive a desktop preview browser partition for scope environment-a.",
      );
      assert.notInclude(error.message, nativeCause.message);
    }).pipe(
      Effect.provide(
        BrowserSession.layer.pipe(
          Layer.provide(failingCryptoLayer),
          Layer.provide(environmentLayer),
        ),
      ),
    );
  });

  it.effect("preserves session scope, partition, and the Electron failure", () =>
    Effect.gen(function* () {
      const cause = new Error("Electron session failed");
      fromPartition.mockImplementationOnce(() => {
        throw cause;
      });
      const browserSessions = yield* BrowserSession.BrowserSession;
      const partition = yield* browserSessions.getPartition("environment-b");
      const error = yield* browserSessions.getSession("environment-b").pipe(Effect.flip);

      assert.instanceOf(error, BrowserSession.BrowserSessionCreationError);
      assert.isTrue(BrowserSession.isBrowserSessionGetSessionError(error));
      assert.isTrue(BrowserSession.isBrowserSessionError(error));
      assert.equal(error.scope, "environment-b");
      assert.equal(error.partition, partition);
      assert.strictEqual(error.cause, cause);
      assert.equal(
        error.message,
        `Failed to create a desktop preview browser session for scope environment-b (partition ${partition}).`,
      );
      assert.notInclude(error.message, cause.message);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("clears storage and cache for every created session", () =>
    Effect.gen(function* () {
      const browserSessions = yield* BrowserSession.BrowserSession;
      yield* browserSessions.getSession("scope-a");
      yield* browserSessions.getSession("scope-b");

      yield* browserSessions.clearCookies();
      yield* browserSessions.clearCache();

      assert.strictEqual(sessions.size, 2);
      for (const browserSession of sessions.values()) {
        assert.strictEqual(browserSession.clearStorageData.mock.calls.length, 1);
        assert.deepEqual(browserSession.clearStorageData.mock.calls[0], [
          {
            storages: ["cookies", "localstorage", "indexdb", "websql", "serviceworkers"],
          },
        ]);
        assert.strictEqual(browserSession.clearCache.mock.calls.length, 1);
      }
    }).pipe(Effect.provide(layer)),
  );

  it.effect("correlates clear failures while still attempting every session", () =>
    Effect.gen(function* () {
      const browserSessions = yield* BrowserSession.BrowserSession;
      yield* browserSessions.getSession("scope-a");
      yield* browserSessions.getSession("scope-b");
      const firstPartition = yield* browserSessions.getPartition("scope-a");
      const secondPartition = yield* browserSessions.getPartition("scope-b");
      const firstSession = sessions.get(firstPartition);
      const secondSession = sessions.get(secondPartition);
      assert.isDefined(firstSession);
      assert.isDefined(secondSession);

      const storageCause = new Error("storage clear failed");
      secondSession.clearStorageData.mockImplementationOnce(() => Promise.reject(storageCause));
      const storageError = yield* browserSessions.clearCookies().pipe(Effect.flip);

      assert.instanceOf(storageError, BrowserSession.BrowserSessionStorageClearError);
      assert.isTrue(BrowserSession.isBrowserSessionError(storageError));
      assert.equal(storageError.partition, secondPartition);
      assert.strictEqual(storageError.cause, storageCause);
      assert.equal(
        storageError.message,
        `Failed to clear desktop preview browser storage for partition ${secondPartition}.`,
      );
      assert.notInclude(storageError.message, storageCause.message);
      for (const browserSession of sessions.values()) {
        assert.strictEqual(browserSession.clearStorageData.mock.calls.length, 1);
      }

      const cacheCause = new Error("cache clear failed");
      firstSession.clearCache.mockImplementationOnce(() => Promise.reject(cacheCause));
      const cacheError = yield* browserSessions.clearCache().pipe(Effect.flip);

      assert.instanceOf(cacheError, BrowserSession.BrowserSessionCacheClearError);
      assert.isTrue(BrowserSession.isBrowserSessionError(cacheError));
      assert.equal(cacheError.partition, firstPartition);
      assert.strictEqual(cacheError.cause, cacheCause);
      assert.equal(
        cacheError.message,
        `Failed to clear the desktop preview browser cache for partition ${firstPartition}.`,
      );
      assert.notInclude(cacheError.message, cacheCause.message);
      for (const browserSession of sessions.values()) {
        assert.strictEqual(browserSession.clearCache.mock.calls.length, 1);
      }
    }).pipe(Effect.provide(layer)),
  );
});
