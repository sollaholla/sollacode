// @effect-diagnostics globalDate:off - The download `done` callback is a
// synchronous Electron callback with no Effect context to draw a clock from.
// @effect-diagnostics nodeBuiltinImport:off - Electron raises the system save
// panel the moment the will-download handler returns without a path, so the
// directory and collision checks there have to be synchronous.
import type { Session } from "electron";
import { Notification, session } from "electron";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as SynchronizedRef from "effect/SynchronizedRef";

import type { PreviewDownload } from "@t3tools/contracts";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import { resolveDownloadFileName, resolveUniqueDownloadPath } from "./downloadPaths.ts";

const PREVIEW_PARTITION_PREFIX = "persist:t3code-preview-";

// Permissions granted to preview web content. `clipboard-sanitized-write` is the
// Electron permission behind `navigator.clipboard.writeText()` — note it is NOT
// `clipboard-write`, which is not a valid Electron permission name. Async
// clipboard writes are gated by the permission *check* handler (not only the
// request handler), so both handlers must allow it; otherwise built-in "Copy"
// buttons — e.g. the Next.js / Vercel error overlay — fail with
// `Failed to execute 'writeText' on 'Clipboard': Write permission denied`.
const ALLOWED_PREVIEW_PERMISSIONS: ReadonlySet<string> = new Set([
  "clipboard-read",
  "clipboard-sanitized-write",
  "notifications",
  "geolocation",
]);

export class BrowserSessionPartitionDerivationError extends Schema.TaggedErrorClass<BrowserSessionPartitionDerivationError>()(
  "BrowserSessionPartitionDerivationError",
  {
    scope: Schema.String,
    cause: Schema.instanceOf(PlatformError.PlatformError),
  },
) {
  override get message(): string {
    return `Failed to derive a desktop preview browser partition for scope ${this.scope}.`;
  }
}

export class BrowserSessionCreationError extends Schema.TaggedErrorClass<BrowserSessionCreationError>()(
  "BrowserSessionCreationError",
  {
    scope: Schema.String,
    partition: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to create a desktop preview browser session for scope ${this.scope} (partition ${this.partition}).`;
  }
}

export class BrowserSessionStorageClearError extends Schema.TaggedErrorClass<BrowserSessionStorageClearError>()(
  "BrowserSessionStorageClearError",
  {
    partition: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to clear desktop preview browser storage for partition ${this.partition}.`;
  }
}

export class BrowserSessionCacheClearError extends Schema.TaggedErrorClass<BrowserSessionCacheClearError>()(
  "BrowserSessionCacheClearError",
  {
    partition: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to clear the desktop preview browser cache for partition ${this.partition}.`;
  }
}

export const BrowserSessionGetSessionError = Schema.Union([
  BrowserSessionPartitionDerivationError,
  BrowserSessionCreationError,
]);
export type BrowserSessionGetSessionError = typeof BrowserSessionGetSessionError.Type;
export const isBrowserSessionGetSessionError = Schema.is(BrowserSessionGetSessionError);

export const BrowserSessionError = Schema.Union([
  BrowserSessionPartitionDerivationError,
  BrowserSessionCreationError,
  BrowserSessionStorageClearError,
  BrowserSessionCacheClearError,
]);
export type BrowserSessionError = typeof BrowserSessionError.Type;
export const isBrowserSessionError = Schema.is(BrowserSessionError);

export class BrowserSession extends Context.Service<
  BrowserSession,
  {
    readonly getPartition: (
      scope?: string,
    ) => Effect.Effect<string, BrowserSessionPartitionDerivationError>;
    readonly isPartition: (partition: string) => boolean;
    readonly getSession: (scope?: string) => Effect.Effect<Session, BrowserSessionGetSessionError>;
    /**
     * Where downloads made in this scope's tabs are written.
     *
     * The renderer owns this: only it knows which workspace a thread is
     * working in. Unset scopes fall back to the app's own artifacts folder, so
     * a download never has nowhere to go.
     */
    readonly setDownloadDirectory: (
      scope: string,
      directory: string,
    ) => Effect.Effect<void, BrowserSessionPartitionDerivationError>;
    /** Recently finished downloads, newest first. */
    readonly recentDownloads: () => ReadonlyArray<PreviewDownload>;
    readonly clearCookies: () => Effect.Effect<void, BrowserSessionStorageClearError>;
    readonly clearCache: () => Effect.Effect<void, BrowserSessionCacheClearError>;
  }
>()("@t3tools/desktop/preview/BrowserSession") {}

export const make = Effect.gen(function* BrowserSessionMake() {
  const crypto = yield* Crypto.Crypto;
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  // Permission handlers are synchronous Electron callbacks, so logging from
  // them has to be forked into the app's logger rather than awaited.
  const runFork = Effect.runForkWith(yield* Effect.context<never>());
  /**
   * Where a preview download lands.
   *
   * Downloads used to raise the system save panel, which meant an agent could
   * fetch a file only if a human was there to click Save — a background agent
   * just hung on it. Giving the item a path up front is what suppresses that
   * panel, so this sits beside the other browser artifacts, where the app
   * already keeps things it produced on the user's behalf.
   */
  const fallbackDownloadsDir = NodePath.join(environment.browserArtifactsDir, "downloads");
  /** Partition -> the workspace directory the renderer nominated for it. */
  const downloadDirectories = new Map<string, string>();
  /**
   * Permissions already reported as denied, so one stubborn page cannot fill
   * the log with the same line.
   *
   * Agents have hit refusals here that are invisible from inside the page —
   * most recently a repeated "multi-download block" whose actual permission
   * name nobody could name. Electron's typed permission union has no entry for
   * automatic downloads, so rather than allow a guessed string, record what is
   * genuinely being asked for and refused.
   */
  const reportedDeniedPermissions = new Set<string>();
  /**
   * Recently finished downloads, newest first.
   *
   * Suppressing the save panel also removed the only sign a download had
   * happened — to the user *and* to the agent that asked for it. One agent
   * re-fetched the same 28 MB video eight times because each silent success
   * looked like a failure. This is what `preview_snapshot` reports back.
   */
  const recentDownloads: Array<PreviewDownload> = [];
  const RECENT_DOWNLOAD_LIMIT = 20;
  const denyPermission = (permission: string): boolean => {
    if (!reportedDeniedPermissions.has(permission)) {
      reportedDeniedPermissions.add(permission);
      runFork(Effect.logWarning("Denied a guest preview permission request.", { permission }));
    }
    return false;
  };
  const sessionsRef = yield* SynchronizedRef.make<ReadonlyMap<string, Session>>(new Map());

  const getPartition = Effect.fn("BrowserSession.getPartition")(function* (scope = "shared") {
    const digest = yield* crypto.digest("SHA-256", new TextEncoder().encode(scope)).pipe(
      Effect.mapError(
        (cause) =>
          new BrowserSessionPartitionDerivationError({
            scope,
            cause,
          }),
      ),
    );
    return `${PREVIEW_PARTITION_PREFIX}${Encoding.encodeHex(digest).slice(0, 20)}`;
  });

  const getSession = Effect.fn("BrowserSession.getSession")(function* (scope = "shared") {
    const partition = yield* getPartition(scope);
    return yield* SynchronizedRef.modifyEffect(sessionsRef, (sessions) => {
      const existing = sessions.get(partition);
      if (existing) return Effect.succeed([existing, sessions] as const);
      return Effect.try({
        try: () => {
          const browserSession = session.fromPartition(partition);
          browserSession.on("will-download", (_downloadEvent, item) => {
            // Must be synchronous: Electron raises the save panel as soon as
            // this handler returns without a path set.
            try {
              const directory = downloadDirectories.get(partition) ?? fallbackDownloadsDir;
              NodeFS.mkdirSync(directory, { recursive: true });
              const savePath = resolveUniqueDownloadPath({
                directory,
                fileName: resolveDownloadFileName(item.getFilename()),
                join: NodePath.join,
                exists: NodeFS.existsSync,
              });
              item.setSavePath(savePath);
              item.once("done", (_doneEvent, state) => {
                const fileName = NodePath.basename(savePath);
                recentDownloads.unshift({
                  fileName,
                  path: savePath,
                  completedAt: new Date().toISOString(),
                  succeeded: state === "completed",
                });
                recentDownloads.length = Math.min(recentDownloads.length, RECENT_DOWNLOAD_LIMIT);
                if (state !== "completed" || !Notification.isSupported()) return;
                // The panel used to be the confirmation. Without it a file
                // arriving is invisible, so say so where the user is looking.
                new Notification({
                  title: "Download finished",
                  body: `${fileName} — saved to ${NodePath.dirname(savePath)}`,
                }).show();
              });
            } catch {
              // Falling through to the save panel is the graceful failure here:
              // the user is asked where to put it rather than losing the file.
            }
          });
          browserSession.setPermissionRequestHandler((_webContents, permission, callback) => {
            callback(ALLOWED_PREVIEW_PERMISSIONS.has(permission) || denyPermission(permission));
          });
          browserSession.setPermissionCheckHandler(
            (_webContents, permission) =>
              ALLOWED_PREVIEW_PERMISSIONS.has(permission) || denyPermission(permission),
          );
          const next = new Map(sessions);
          next.set(partition, browserSession);
          return [browserSession, next] as const;
        },
        catch: (cause) =>
          new BrowserSessionCreationError({
            scope,
            partition,
            cause,
          }),
      });
    });
  });

  const setDownloadDirectory = Effect.fn("BrowserSession.setDownloadDirectory")(function* (
    scope: string,
    directory: string,
  ) {
    const partition = yield* getPartition(scope);
    downloadDirectories.set(partition, directory);
  });

  return BrowserSession.of({
    getPartition,
    setDownloadDirectory,
    recentDownloads: () => [...recentDownloads],
    isPartition: (partition) => partition.startsWith(PREVIEW_PARTITION_PREFIX),
    getSession,
    clearCookies: Effect.fn("BrowserSession.clearCookies")(function* () {
      const sessions = yield* SynchronizedRef.get(sessionsRef);
      yield* Effect.all(
        [...sessions.entries()].map(([partition, browserSession]) =>
          Effect.tryPromise({
            try: () =>
              browserSession.clearStorageData({
                storages: ["cookies", "localstorage", "indexdb", "websql", "serviceworkers"],
              }),
            catch: (cause) =>
              new BrowserSessionStorageClearError({
                partition,
                cause,
              }),
          }),
        ),
        { concurrency: "unbounded", discard: true },
      );
    }),
    clearCache: Effect.fn("BrowserSession.clearCache")(function* () {
      const sessions = yield* SynchronizedRef.get(sessionsRef);
      yield* Effect.all(
        [...sessions.entries()].map(([partition, browserSession]) =>
          Effect.tryPromise({
            try: () => browserSession.clearCache(),
            catch: (cause) =>
              new BrowserSessionCacheClearError({
                partition,
                cause,
              }),
          }),
        ),
        { concurrency: "unbounded", discard: true },
      );
    }),
  });
}).pipe(Effect.withSpan("BrowserSession.make"));

export const layer = Layer.effect(BrowserSession, make);
