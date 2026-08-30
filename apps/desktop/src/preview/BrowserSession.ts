// @effect-diagnostics globalDate:off - The download `done` callback is a
// synchronous Electron callback with no Effect context to draw a clock from.
// @effect-diagnostics nodeBuiltinImport:off - Electron raises the system save
// panel the moment the will-download handler returns without a path, so the
// directory and collision checks there have to be synchronous.
import type { Session } from "electron";
import { app, Notification, session } from "electron";
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

import type { PreviewDownload, PreviewDownloadApproval } from "@t3tools/contracts";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import {
  downloadDomain,
  resolveDownloadApproval,
  resolveDownloadApprovalEffects,
} from "./downloadApproval.ts";
import { resolveDownloadFileName, resolveUniqueDownloadPath } from "./downloadPaths.ts";
import { selectLegacyBrowserProfile } from "./browserProfileScope.ts";

const PREVIEW_PARTITION_PREFIX = "persist:t3code-preview-";
// Electron strips the `persist:` marker when it names the on-disk folder.
const PARTITION_DIRECTORY_PREFIX = PREVIEW_PARTITION_PREFIX.slice("persist:".length);

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

/**
 * A download held for the user's answer, or the end of that hold.
 *
 * `settled` carries no verdict because the card only needs to know it can go;
 * an allowed file arrives through the ordinary download notice instead.
 */
export type DownloadApprovalEvent =
  | { readonly kind: "pending"; readonly approval: PreviewDownloadApproval }
  | { readonly kind: "settled"; readonly id: string };

export class BrowserSession extends Context.Service<
  BrowserSession,
  {
    readonly getPartition: (
      scope: string,
    ) => Effect.Effect<string, BrowserSessionPartitionDerivationError>;
    readonly isPartition: (partition: string) => boolean;
    /**
     * One-time move of the busiest legacy per-thread profile onto `scope`, so
     * sharing one profile does not read as being signed out of every site.
     */
    readonly adoptLegacyProfile: (
      scope: string,
    ) => Effect.Effect<void, BrowserSessionPartitionDerivationError>;
    readonly getSession: (scope: string) => Effect.Effect<Session, BrowserSessionGetSessionError>;
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
    /**
     * Called as each download finishes, with the guest that started it, so the
     * manager can put the notice on that specific tab.
     */
    readonly onDownload: (
      listener: (webContentsId: number, download: PreviewDownload) => void,
    ) => void;
    /**
     * Called when a download from an unapproved site starts, and again when
     * that hold is settled, so the manager can raise and clear the card on the
     * tab that asked for the file.
     */
    readonly onDownloadApproval: (
      listener: (webContentsId: number, event: DownloadApprovalEvent) => void,
    ) => void;
    /** Answer a held download. Unknown ids are ignored: the hold is gone. */
    readonly answerDownloadApproval: (
      id: string,
      decision: "allow-domain" | "allow-once" | "deny",
    ) => void;
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
  const downloadListeners = new Set<(webContentsId: number, download: PreviewDownload) => void>();
  /**
   * Sites the user has said may write into the workspace, for this run of the
   * app only. See `downloadApproval.ts` for why this is not persisted.
   */
  const allowedDownloadDomains = new Set<string>();
  const approvalListeners = new Set<
    (webContentsId: number, event: DownloadApprovalEvent) => void
  >();
  /**
   * A download whose bytes are landing in staging while the user decides.
   *
   * Holding the *file* rather than the *transfer* is deliberate: pausing a
   * DownloadItem only resumes if the server honours range requests, so a
   * "Allow" on a plain static host could strand the file forever. Letting it
   * finish into a staging directory beside the real one costs a rename on
   * approval and an unlink on refusal, and never depends on the server.
   */
  interface HeldDownload {
    readonly webContentsId: number;
    readonly domain: string;
    readonly fileName: string;
    readonly stagingPath: string;
    readonly directory: string;
    readonly item: Electron.DownloadItem;
    /** Set once the transfer finishes; until then there is nothing to move. */
    landed: boolean;
    /** Set if the user answered before the bytes arrived. */
    decision: "allow-domain" | "allow-once" | "deny" | null;
  }
  const heldDownloads = new Map<string, HeldDownload>();
  let heldDownloadSeq = 0;
  const notifyApproval = (webContentsId: number, event: DownloadApprovalEvent) => {
    for (const listener of approvalListeners) {
      try {
        listener(webContentsId, event);
      } catch {
        // One bad listener must not stop the notice reaching the rest.
      }
    }
  };
  const publishDownload = (webContentsId: number, download: PreviewDownload) => {
    recentDownloads.unshift(download);
    recentDownloads.length = Math.min(recentDownloads.length, RECENT_DOWNLOAD_LIMIT);
    for (const listener of downloadListeners) {
      try {
        listener(webContentsId, download);
      } catch {
        // One bad listener must not stop the notice reaching the rest.
      }
    }
    if (!download.succeeded || !Notification.isSupported()) return;
    // The panel used to be the confirmation. Without it a file arriving is
    // invisible, so say so where the user is looking.
    new Notification({
      title: "Download finished",
      body: `${download.fileName} — saved to ${NodePath.dirname(download.path)}`,
    }).show();
  };
  /**
   * Applies an answer to a download whose bytes are already in staging.
   *
   * Only ever called with both halves present — an answer and a finished
   * transfer — so the two orders the user can produce (answer first, or let it
   * land first) converge here.
   */
  /**
   * Removes staged files no live hold is waiting on.
   *
   * A crash or a force quit while a card was on screen leaves bytes the user
   * never allowed sitting under their workspace — the exact thing the hold
   * exists to prevent. Runs when a workspace is nominated, which is often
   * enough and never mid-question, because anything still being decided is
   * still in `heldDownloads`.
   */
  const sweepAbandonedHolds = (directory: string) => {
    const stagingDirectory = NodePath.join(directory, ".pending-approval");
    let staged: ReadonlyArray<string>;
    try {
      staged = NodeFS.readdirSync(stagingDirectory);
    } catch {
      return;
    }
    const awaited = new Set([...heldDownloads.values()].map((held) => held.stagingPath));
    for (const entry of staged) {
      const stagedPath = NodePath.join(stagingDirectory, entry);
      if (awaited.has(stagedPath)) continue;
      try {
        NodeFS.rmSync(stagedPath, { force: true, recursive: true });
      } catch {
        // A file we cannot remove is not worth failing the workspace change.
      }
    }
  };

  const settleHeldDownload = (id: string, held: HeldDownload) => {
    const decision = held.decision;
    if (decision === null || !held.landed) return;
    heldDownloads.delete(id);
    const { keepFile, rememberDomain } = resolveDownloadApprovalEffects(decision);
    if (rememberDomain && held.domain.length > 0) allowedDownloadDomains.add(held.domain);
    notifyApproval(held.webContentsId, { kind: "settled", id });
    if (!keepFile) {
      try {
        NodeFS.rmSync(held.stagingPath, { force: true });
      } catch {
        // A staged file we cannot remove is not worth failing the answer over.
      }
      return;
    }
    try {
      const finalPath = resolveUniqueDownloadPath({
        directory: held.directory,
        fileName: held.fileName,
        join: NodePath.join,
        exists: NodeFS.existsSync,
      });
      NodeFS.renameSync(held.stagingPath, finalPath);
      publishDownload(held.webContentsId, {
        fileName: NodePath.basename(finalPath),
        path: finalPath,
        completedAt: new Date().toISOString(),
        succeeded: true,
      });
    } catch {
      // The bytes are there but could not be moved into place. Report it as a
      // failed download rather than claiming a file the user cannot find.
      publishDownload(held.webContentsId, {
        fileName: held.fileName,
        path: held.stagingPath,
        completedAt: new Date().toISOString(),
        succeeded: false,
      });
    }
  };
  const denyPermission = (permission: string): boolean => {
    if (!reportedDeniedPermissions.has(permission)) {
      reportedDeniedPermissions.add(permission);
      runFork(Effect.logWarning("Denied a guest preview permission request.", { permission }));
    }
    return false;
  };
  const sessionsRef = yield* SynchronizedRef.make<ReadonlyMap<string, Session>>(new Map());
  let adoptedSharedProfile = false;

  // No default scope. A caller that lost its environment id used to fall
  // through to a `"shared"` scope, which silently minted a *second*, empty
  // profile: the user stayed signed in on their own tabs while agent tabs
  // attached to the empty jar and read every site as logged out. Requiring the
  // scope turns that into a compile error instead of a phantom profile.
  const getPartition = Effect.fn("BrowserSession.getPartition")(function* (scope: string) {
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

  /**
   * Move the richest legacy per-thread profile onto the shared partition.
   *
   * Browser profiles used to be keyed per thread, so every conversation and
   * every agent got an empty cookie jar and saw each site logged out while the
   * user was signed in one thread over. Pointing them all at one partition
   * fixes that going forward, but the signed-in cookies still live in the jar
   * whichever thread happened to log in. Without this the switch would read as
   * "the update signed me out of everything", so the busiest existing jar is
   * adopted as the shared one. Cookie count is the signal for "where the
   * logins are"; the file only grows with stored cookies.
   *
   * Runs before any session is opened, so no Chromium process holds the
   * directory. It is a rename, so nothing is copied and nothing is lost.
   */
  const adoptLegacyProfile = Effect.fn("BrowserSession.adoptLegacyProfile")(function* (
    scope: string,
  ) {
    const partition = yield* getPartition(scope);
    // Held against the session map for the whole rename. Several guests ask
    // for their config at once on startup; the first adopts while the others
    // fall straight through to `getSession`. Without this lock one of them
    // opened the partition mid-rename, and Electron's per-partition session
    // stayed bound to the directory that had just been moved aside — cookies
    // written to a jar nothing would read again, which looked exactly like
    // the adoption never happening.
    yield* SynchronizedRef.updateEffect(sessionsRef, (sessions) =>
      Effect.suspend(() => {
        if (adoptedSharedProfile || sessions.has(partition)) return Effect.succeed(sessions);
        adoptedSharedProfile = true;
        return adoptOnDisk(partition).pipe(Effect.as(sessions));
      }),
    );
  });

  /**
   * Size of a profile's cookie database, wherever Chromium put it.
   *
   * The jar sits at the profile root on some Chromium versions and under
   * `Network/` on others. Measuring only the root reads every candidate as
   * empty on the layouts that use the subdirectory, so the one-time adoption
   * quietly picks nothing — which lands the user on a fresh profile and reads
   * as the update having signed them out of every site.
   */
  const cookieJarBytes = (partitionsDir: string, directory: string): number => {
    for (const relative of [["Cookies"], ["Network", "Cookies"]]) {
      const size = NodeFS.statSync(NodePath.join(partitionsDir, directory, ...relative), {
        throwIfNoEntry: false,
      })?.size;
      if (size !== undefined && size > 0) return size;
    }
    return 0;
  };

  const adoptOnDisk = (partition: string) =>
    Effect.sync(() => {
      const partitionsDir = NodePath.join(app.getPath("userData"), "Partitions");
      if (!NodeFS.existsSync(partitionsDir)) return;
      const targetName = partition.slice("persist:".length);
      const profiles = NodeFS.readdirSync(partitionsDir, { withFileTypes: true }).flatMap(
        (entry) => {
          if (!entry.isDirectory() || !entry.name.startsWith(PARTITION_DIRECTORY_PREFIX)) return [];
          return [
            { directory: entry.name, cookieBytes: cookieJarBytes(partitionsDir, entry.name) },
          ];
        },
      );
      // The target is one of the candidates. The environment-wide profile
      // already existed as the old threadless fallback, and its sessions had
      // long since expired — landing everyone on it read exactly like the bug
      // it was meant to fix, so an existing target is not on its own a reason
      // to stop.
      const adopted = selectLegacyBrowserProfile(profiles);
      if (adopted === null || adopted === targetName) return;
      const target = NodePath.join(partitionsDir, targetName);
      if (NodeFS.existsSync(target)) {
        // Moved aside rather than removed: it is the user's browsing history,
        // and a wrong pick here should be recoverable by hand. Numbered rather
        // than timestamped so this needs no clock inside a sync Electron path.
        let aside = `${target}.superseded`;
        for (let attempt = 2; NodeFS.existsSync(aside); attempt += 1) {
          aside = `${target}.superseded-${attempt}`;
        }
        NodeFS.renameSync(target, aside);
      }
      NodeFS.renameSync(NodePath.join(partitionsDir, adopted), target);
    }).pipe(
      // A profile that cannot be adopted is not worth failing preview over:
      // the user signs in once more and the shared jar fills from there.
      Effect.catchCause((cause) =>
        Effect.logWarning("Could not adopt an existing browser profile.", { cause }),
      ),
    );

  const getSession = Effect.fn("BrowserSession.getSession")(function* (scope: string) {
    const partition = yield* getPartition(scope);
    return yield* SynchronizedRef.modifyEffect(sessionsRef, (sessions) => {
      const existing = sessions.get(partition);
      if (existing) return Effect.succeed([existing, sessions] as const);
      return Effect.try({
        try: () => {
          const browserSession = session.fromPartition(partition);
          // Present the Chrome the guest actually is. Electron's default UA
          // carries `Electron/x.y.z` and an app token, and Google refuses
          // OAuth sign-in to any UA with an embedded-framework marker ("this
          // browser or app may not be secure" / disallowed_useragent) — other
          // providers copy the policy. Only those two tokens go; platform and
          // Chrome versions stay truthful. This stripping shipped with the
          // first preview panel and was dropped in cf27a4200 under a
          // "browser integrity checks" rationale, which broke sign-in on
          // every fresh profile — machines with existing Google cookies
          // coasted, which is why it surfaced on a new Windows install
          // (2026-08-30) months before anyone saw it on the Mac.
          const nativeUserAgent = browserSession.getUserAgent();
          const appToken =
            typeof app?.getName === "function"
              ? app.getName().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
              : null;
          const cleanedUserAgent = nativeUserAgent
            .replace(/\sElectron\/[\d.]+/g, "")
            .replace(/\st3code\/[\d.]+/g, "")
            .replace(appToken ? new RegExp(`\\s${appToken}\\/[\\d.]+`, "g") : /$^/, "")
            .replace(/\s{2,}/g, " ")
            .trim();
          if (cleanedUserAgent !== nativeUserAgent && cleanedUserAgent.length > 0) {
            browserSession.setUserAgent(cleanedUserAgent);
          }
          browserSession.on("will-download", (_downloadEvent, item, guest) => {
            // Must be synchronous: Electron raises the save panel as soon as
            // this handler returns without a path set.
            try {
              const webContentsId = guest?.id ?? -1;
              const directory = downloadDirectories.get(partition) ?? fallbackDownloadsDir;
              NodeFS.mkdirSync(directory, { recursive: true });
              const fileName = resolveDownloadFileName(item.getFilename());
              // The guest's own URL is the fallback for downloads with no host
              // of their own — `data:`, and the `blob:null` a sandboxed frame
              // produces.
              let pageUrl = "";
              try {
                pageUrl = guest?.getURL() ?? "";
              } catch {
                // A guest torn down mid-download has no URL to offer.
              }
              const domain = downloadDomain(item.getURL(), pageUrl);
              const approval = resolveDownloadApproval({
                domain,
                allowedDomains: allowedDownloadDomains,
              });

              if (approval === "allowed") {
                const savePath = resolveUniqueDownloadPath({
                  directory,
                  fileName,
                  join: NodePath.join,
                  exists: NodeFS.existsSync,
                });
                item.setSavePath(savePath);
                item.once("done", (_doneEvent, state) => {
                  publishDownload(webContentsId, {
                    fileName: NodePath.basename(savePath),
                    path: savePath,
                    completedAt: new Date().toISOString(),
                    succeeded: state === "completed",
                  });
                });
                return;
              }

              // Unapproved: the transfer runs, but into a staging directory
              // beside the real one, so the file only enters the workspace if
              // the user says so. Same filesystem, so approving is a rename.
              heldDownloadSeq += 1;
              const id = `download-approval-${heldDownloadSeq}`;
              const stagingDirectory = NodePath.join(directory, ".pending-approval");
              NodeFS.mkdirSync(stagingDirectory, { recursive: true });
              const stagingPath = resolveUniqueDownloadPath({
                directory: stagingDirectory,
                fileName,
                join: NodePath.join,
                exists: NodeFS.existsSync,
              });
              item.setSavePath(stagingPath);
              const held: HeldDownload = {
                webContentsId,
                domain,
                fileName,
                stagingPath,
                directory,
                item,
                landed: false,
                decision: null,
              };
              heldDownloads.set(id, held);
              notifyApproval(webContentsId, {
                kind: "pending",
                approval: { id, domain, fileName },
              });
              if (Notification.isSupported()) {
                new Notification({
                  title: "Download needs approval",
                  body: `${domain.length > 0 ? domain : "This page"} wants to save ${fileName}. Allow or deny it in Solla Code.`,
                }).show();
              }
              item.once("done", (_doneEvent, state) => {
                if (!heldDownloads.has(id)) return;
                if (state !== "completed") {
                  // Cancelled or interrupted before any answer. There is
                  // nothing to approve, so drop the card and the staged bytes.
                  heldDownloads.delete(id);
                  notifyApproval(webContentsId, { kind: "settled", id });
                  try {
                    NodeFS.rmSync(stagingPath, { force: true });
                  } catch {
                    // Nothing worth failing a cancelled download over.
                  }
                  return;
                }
                held.landed = true;
                settleHeldDownload(id, held);
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
    yield* Effect.sync(() => sweepAbandonedHolds(directory));
  });

  // Nothing ever nominates the fallback directory, so a hold staged there —
  // a download in a tab with no workspace of its own — would outlive the run
  // that created it with no later sweep to catch it. Startup is that sweep:
  // no hold can be live yet, so anything still staged is abandoned.
  yield* Effect.sync(() => sweepAbandonedHolds(fallbackDownloadsDir));

  return BrowserSession.of({
    getPartition,
    setDownloadDirectory,
    recentDownloads: () => [...recentDownloads],
    onDownload: (listener) => {
      downloadListeners.add(listener);
    },
    onDownloadApproval: (listener) => {
      approvalListeners.add(listener);
    },
    answerDownloadApproval: (id, decision) => {
      const held = heldDownloads.get(id);
      if (!held) return;
      held.decision = decision;
      // Denying while bytes are still arriving stops the transfer too; the
      // `done` handler then finds the hold already gone and leaves it alone.
      if (decision === "deny" && !held.landed) {
        heldDownloads.delete(id);
        notifyApproval(held.webContentsId, { kind: "settled", id });
        try {
          held.item.cancel();
        } catch {
          // An item that already finished cannot be cancelled; the staged
          // file below is removed either way.
        }
        try {
          NodeFS.rmSync(held.stagingPath, { force: true });
        } catch {
          // A staged file we cannot remove is not worth failing the answer over.
        }
        return;
      }
      settleHeldDownload(id, held);
    },
    isPartition: (partition) => partition.startsWith(PREVIEW_PARTITION_PREFIX),
    adoptLegacyProfile,
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
