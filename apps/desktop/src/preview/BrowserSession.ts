// @effect-diagnostics globalDate:off - The download `done` callback is a
// synchronous Electron callback with no Effect context to draw a clock from.
// @effect-diagnostics globalFetch:off - Checks a closed jar's session with an explicit Cookie
// header, which is exactly what must not go through a profile's own cookie store.
// @effect-diagnostics nodeBuiltinImport:off - Electron raises the system save
// panel the moment the will-download handler returns without a path, so the
// directory and collision checks there have to be synchronous.
import type { Session } from "electron";
import { app, Notification, session } from "electron";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as Context from "effect/Context";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as SynchronizedRef from "effect/SynchronizedRef";

import type {
  PreviewAccountEvent,
  PreviewDownload,
  PreviewDownloadApproval,
  ThreadId,
} from "@t3tools/contracts";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import {
  DESKTOP_DEVELOPMENT_SCHEME,
  DESKTOP_HOST,
  DESKTOP_PRODUCTION_SCHEME,
} from "../electron/ElectronProtocol.ts";
import {
  downloadDomain,
  parseDownloadAllowlist,
  resolveDownloadApproval,
  resolveDownloadApprovalEffects,
  serializeDownloadAllowlist,
} from "./downloadApproval.ts";
import { resolveDownloadFileName, resolveUniqueDownloadPath } from "./downloadPaths.ts";
import { previewBrowserProfileScope } from "./browserProfileScope.ts";
import {
  makeBrowserAccountTracker,
  rewriteStoredCookies,
  type BrowserAccountTracker,
} from "./browserAccounts.ts";
import {
  GOOGLE_ACCOUNT_LIST_URL,
  applyProfileSweep,
  countPlaintextCookies,
  foldThreadProfilesIntoProjects,
  parseGoogleAccountList,
  planProfileSweep,
  profileRecordForScope,
  readProfileManifest,
  scrubPlaintextCookies,
  writeProfileManifest,
  type BrowserProfileInventory,
  type BrowserProfileManifest,
  type GoogleSessionProbe,
} from "./browserProfiles.ts";
import { storageCleanupEnabled } from "../storage/storageCleanupSettings.ts";

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

const DESKTOP_APP_PROTOCOLS: ReadonlySet<string> = new Set([
  `${DESKTOP_PRODUCTION_SCHEME}:`,
  `${DESKTOP_DEVELOPMENT_SCHEME}:`,
]);

/**
 * The app window capturing a tab's sound for a remote listener. Chromium asks
 * the CAPTURED tab's session about a tab capture, so without this the guest
 * rules below refused it ("NotAllowedError: Permission denied") and remote
 * viewers heard nothing. `securityOrigin` is the frame that asked, which a
 * page inside the tab can never be; pages keep being denied the microphone.
 */
export function isAppTabAudioCapture(permission: string, details: unknown): boolean {
  if (permission !== "media" || typeof details !== "object" || details === null) return false;
  const { securityOrigin, mediaTypes } = details as {
    readonly securityOrigin?: unknown;
    readonly mediaTypes?: ReadonlyArray<unknown>;
  };
  if (!(mediaTypes ?? []).every((type) => type === "audio")) return false;
  if (typeof securityOrigin !== "string") return false;
  try {
    const origin = new URL(securityOrigin);
    return DESKTOP_APP_PROTOCOLS.has(origin.protocol) && origin.hostname === DESKTOP_HOST;
  } catch {
    return false;
  }
}

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

/** Where the remembered "Allow for this domain" answers live, under the state dir. */
export const DOWNLOAD_ALLOWLIST_FILE_NAME = "preview-download-allowlist.json";

function readDownloadAllowlist(path: string): Set<string> {
  let raw: string;
  try {
    raw = NodeFS.readFileSync(path, "utf8");
  } catch {
    return new Set();
  }
  return new Set(parseDownloadAllowlist(raw));
}

/** Written whole into a sibling and renamed, so a crash mid-write cannot leave a half file. */
function writeDownloadAllowlist(path: string, domains: ReadonlySet<string>): void {
  NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
  const staging = `${path}.tmp`;
  NodeFS.writeFileSync(staging, serializeDownloadAllowlist(domains), "utf8");
  NodeFS.renameSync(staging, path);
}

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
     * Take in what exists in an environment. The first report folds its old
     * per-thread folders into per-project ones; every report lets the sweep
     * retire profiles whose project or agent is gone.
     */
    readonly reconcileProfiles: (inventory: BrowserProfileInventory) => Effect.Effect<void>;
    /** Who is signed in where, and sign-in events. */
    readonly accounts: BrowserAccountTracker;
    /** Owner of a profile folder, if it has one. */
    readonly profileKind: (directory: string) => "project" | "agent" | null;
    /** The periodic pass: retire what has lost its owner and re-check who is signed in. */
    readonly maintainProfiles: () => Effect.Effect<void>;
    readonly profileCounts: () => {
      readonly profiles: number;
      readonly retired: number;
      readonly encrypted: number;
    };
    /** The folder for a scope, so a tab or account action can name a profile. */
    readonly directoryForScope: (
      scope: string,
    ) => Effect.Effect<string, BrowserSessionPartitionDerivationError>;
    readonly onAccountEvent: (listener: (event: PreviewAccountEvent) => void) => void;
    /** Which thread a guest belongs to, so its downloads follow that thread's worktree. */
    readonly noteGuestThread: (webContentsId: number, threadId: string | null) => void;
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
      threadId?: string,
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
    /**
     * Forget every site remembered by "Allow for this domain", in memory and
     * on disk, so each asks again on its next download.
     */
    readonly forgetDownloadDomains: () => void;
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
  /** Partition -> the workspace directory last nominated for it. */
  const downloadDirectories = new Map<string, string>();
  /** Partition + thread -> that thread's own workspace, which can be a worktree. */
  const threadDownloadDirectories = new Map<string, string>();
  const guestThreads = new Map<number, string>();
  const downloadDirectoryFor = (partition: string, webContentsId: number): string => {
    const threadId = guestThreads.get(webContentsId);
    return (
      (threadId === undefined
        ? undefined
        : threadDownloadDirectories.get(`${partition}\u0000${threadId}`)) ??
      downloadDirectories.get(partition) ??
      fallbackDownloadsDir
    );
  };
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
   * Sites the user has said may write into the workspace.
   *
   * Loaded from and written back to disk, so an answer survives the restart
   * every update forces. See `downloadApproval.ts` for the file format and
   * for why an unreadable file means "ask", not "allow".
   */
  const allowedDownloadDomainsPath = NodePath.join(
    environment.stateDir,
    DOWNLOAD_ALLOWLIST_FILE_NAME,
  );
  const allowedDownloadDomains = readDownloadAllowlist(allowedDownloadDomainsPath);
  const persistAllowedDownloadDomains = () => {
    try {
      writeDownloadAllowlist(allowedDownloadDomainsPath, allowedDownloadDomains);
    } catch (cause) {
      // The answer still holds for this run; only its memory across restarts
      // is lost, which is worth a log line and not a failed download.
      runFork(
        Effect.logWarning("Could not persist the download allowlist.", {
          path: allowedDownloadDomainsPath,
          cause,
        }),
      );
    }
  };
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
    if (rememberDomain && held.domain.length > 0 && !allowedDownloadDomains.has(held.domain)) {
      allowedDownloadDomains.add(held.domain);
      persistAllowedDownloadDomains();
    }
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

  const partitionsDir = () => NodePath.join(app.getPath("userData"), "Partitions");
  const directoryOfPartition = (partition: string) => partition.slice("persist:".length);
  // Lazy, because `app` paths are only meaningful once Electron is up.
  let manifestCache: BrowserProfileManifest | null = null;
  const manifest = (): BrowserProfileManifest => {
    manifestCache ??= readProfileManifest(partitionsDir());
    return manifestCache;
  };
  const saveManifest = (next: BrowserProfileManifest) => {
    manifestCache = next;
    try {
      writeProfileManifest(partitionsDir(), next);
    } catch (cause) {
      runFork(Effect.logWarning("Could not save the browser profile manifest.", { cause }));
    }
  };
  const inventories = new Map<string, BrowserProfileInventory>();
  let hostedEnvironmentIds: ReadonlyArray<string> = [];
  const accountEventListeners = new Set<(event: PreviewAccountEvent) => void>();

  const scopeOfDirectory = (directory: string): string | null => {
    const record = manifest().profiles[directory];
    if (!record) return null;
    return record.kind === "project"
      ? previewBrowserProfileScope(record.environmentId, {
          kind: "project",
          projectId: record.ownerId,
        })
      : previewBrowserProfileScope(record.environmentId, {
          kind: "agent",
          rootThreadId: record.ownerId as ThreadId,
        });
  };

  const accounts = makeBrowserAccountTracker({
    logPath: NodePath.join(environment.logDir, "browser-accounts.ndjson"),
    ownerOf: (directory) => manifest().profiles[directory] ?? null,
    linksOf: () => manifest().accountLinks,
    addLink: (link) => {
      const current = manifest();
      const exists = current.accountLinks.some(
        (known) =>
          known.provider === link.provider &&
          known.profiles.includes(link.profiles[0]) &&
          known.profiles.includes(link.profiles[1]),
      );
      if (!exists) saveManifest({ ...current, accountLinks: [...current.accountLinks, link] });
    },
    removeLink: (provider, directory) => {
      const current = manifest();
      saveManifest({
        ...current,
        accountLinks: current.accountLinks.filter(
          (link) => link.provider !== provider || !link.profiles.includes(directory),
        ),
      });
    },
    openSession: (directory) => {
      const scope = scopeOfDirectory(directory);
      return scope === null
        ? Promise.resolve(null)
        : Effect.runPromise(getSession(scope).pipe(Effect.orElseSucceed(() => null)));
    },
    onEvent: (event) => {
      for (const listener of accountEventListeners) {
        try {
          listener(event);
        } catch {
          // One bad listener must not stop the notice reaching the rest.
        }
      }
    },
    onFailure: (operation, cause) => {
      runFork(Effect.logWarning("A browser account check failed.", { operation, cause }));
    },
  });

  /** Encrypt what a jar stored before encryption was on, before any page can load in it. */
  const encryptStoredCookies = Effect.fn("BrowserSession.encryptStoredCookies")(function* (
    directory: string,
    browserSession: Session,
  ) {
    if (!app.isPackaged || manifest().encryptedJars.includes(directory)) return;
    const plainBefore = countPlaintextCookies(partitionsDir(), directory);
    if (plainBefore > 0) {
      const result = yield* Effect.tryPromise(() => rewriteStoredCookies(browserSession));
      const plainAfter = countPlaintextCookies(partitionsDir(), directory);
      yield* Effect.logInfo("Encrypted a browser profile's stored cookies.", {
        directory,
        ...result,
        plainBefore,
        plainAfter,
      });
      // Nothing moved: this build has encryption off, so the plain rows are all
      // the jar has and scrubbing them would sign it out of everything.
      if (plainAfter >= plainBefore) return;
    }
    const current = manifest();
    saveManifest({
      ...current,
      encryptedJars: [...current.encryptedJars, directory],
      pendingScrub: plainBefore > 0 ? [...current.pendingScrub, directory] : current.pendingScrub,
    });
  });

  const getSession = Effect.fn("BrowserSession.getSession")(function* (scope: string) {
    const partition = yield* getPartition(scope);
    const directory = directoryOfPartition(partition);
    return yield* SynchronizedRef.modifyEffect(sessionsRef, (sessions) =>
      Effect.gen(function* () {
        const existing = sessions.get(partition);
        if (existing) return [existing, sessions] as const;
        const record = profileRecordForScope(scope);
        if (record !== null && manifest().profiles[directory] === undefined) {
          const current = manifest();
          saveManifest({
            ...current,
            profiles: { ...current.profiles, [directory]: record },
          });
        }
        if (manifest().pendingScrub.includes(directory)) {
          yield* Effect.sync(() => scrubPlaintextCookies(partitionsDir(), directory)).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("Could not scrub a browser profile's old cookies.", {
                directory,
                cause,
              }),
            ),
          );
          const current = manifest();
          saveManifest({
            ...current,
            pendingScrub: current.pendingScrub.filter((name) => name !== directory),
          });
        }
        const opened = yield* Effect.try({
          try: () => {
            const browserSession = session.fromPartition(partition);
            browserSession.on("will-download", (_downloadEvent, item, guest) => {
              // Must be synchronous: Electron raises the save panel as soon as
              // this handler returns without a path set.
              try {
                const webContentsId = guest?.id ?? -1;
                const directory = downloadDirectoryFor(partition, webContentsId);
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
            browserSession.setPermissionRequestHandler(
              (_webContents, permission, callback, details) => {
                callback(
                  ALLOWED_PREVIEW_PERMISSIONS.has(permission) ||
                    isAppTabAudioCapture(permission, details) ||
                    denyPermission(permission),
                );
              },
            );
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
        // Held under the sessions lock: no guest can attach until this finishes.
        yield* encryptStoredCookies(directory, opened[0]).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Could not encrypt a browser profile's cookies.", {
              directory,
              cause,
            }),
          ),
        );
        accounts.attach(directory, opened[0]);
        return opened;
      }),
    );
  });

  /** Ask Google whether a closed jar's session is alive, without opening the jar. */
  const probeGoogleSession: GoogleSessionProbe = async (cookieHeader) => {
    const response = await fetch(GOOGLE_ACCOUNT_LIST_URL, {
      method: "POST",
      headers: { Cookie: cookieHeader, Origin: "https://accounts.google.com" },
      signal: AbortSignal.timeout(4_000),
    });
    if (!response.ok) return null;
    return {
      liveAccounts: parseGoogleAccountList(await response.text()).filter((account) => account.live)
        .length,
    };
  };

  const sweepProfiles = Effect.fn("BrowserSession.sweepProfiles")(function* () {
    const nowMs = yield* Clock.currentTimeMillis;
    const sessions = yield* SynchronizedRef.get(sessionsRef);
    const purgeEnabled = yield* Effect.tryPromise(() =>
      storageCleanupEnabled(environment.serverSettingsPath),
    ).pipe(Effect.orElseSucceed(() => false));
    const plan = planProfileSweep({
      partitionsDir: partitionsDir(),
      manifest: manifest(),
      inventories,
      hostedEnvironmentIds,
      openDirectories: new Set([...sessions.keys()].map(directoryOfPartition)),
      nowMs,
    });
    if (plan.retire.length === 0 && plan.purge.length === 0 && plan.forget.length === 0) return;
    const applied = applyProfileSweep({
      partitionsDir: partitionsDir(),
      manifest: manifest(),
      plan,
      nowMs,
      purgeEnabled,
    });
    saveManifest(applied.manifest);
    yield* Effect.logInfo("Browser profile sweep complete.", {
      retired: applied.retired.length,
      purged: applied.purged.length,
      failures: applied.failures,
    });
  });

  const reconcileProfiles = Effect.fn("BrowserSession.reconcileProfiles")(function* (
    inventory: BrowserProfileInventory,
  ) {
    inventories.set(inventory.environmentId, inventory);
    hostedEnvironmentIds = inventory.hostedEnvironmentIds;
    yield* SynchronizedRef.updateEffect(sessionsRef, (sessions) =>
      Effect.gen(function* () {
        if (manifest().migratedEnvironments.includes(inventory.environmentId)) return sessions;
        const nowMs = yield* Clock.currentTimeMillis;
        const result = yield* Effect.tryPromise(() =>
          foldThreadProfilesIntoProjects({
            partitionsDir: partitionsDir(),
            inventory,
            manifest: manifest(),
            openDirectories: new Set([...sessions.keys()].map(directoryOfPartition)),
            probeGoogle: probeGoogleSession,
            nowMs,
          }),
        );
        saveManifest(result.manifest);
        yield* Effect.logInfo("Folded per-thread browser profiles into projects.", {
          environmentId: inventory.environmentId,
          folded: result.folded,
        });
        return sessions;
      }),
    ).pipe(
      // Guests are waiting on this. A failed fold costs a sign-in, never the browser.
      Effect.catchCause((cause) =>
        Effect.logWarning("Could not fold browser profiles.", { cause }),
      ),
    );
    // Opening every owned profile encrypts what it holds and lets the tracker
    // see who is signed in, so the page and the sign-in offers have answers.
    for (const directory of Object.keys(manifest().profiles)) {
      const record = manifest().profiles[directory];
      if (record?.environmentId !== inventory.environmentId) continue;
      if (!NodeFS.existsSync(NodePath.join(partitionsDir(), directory))) continue;
      const scope = scopeOfDirectory(directory);
      if (scope !== null) yield* getSession(scope).pipe(Effect.ignore);
    }
    yield* sweepProfiles().pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Could not sweep browser profiles.", { cause }),
      ),
    );
    yield* Effect.tryPromise(() => accounts.refreshAll()).pipe(
      Effect.andThen(
        Effect.suspend(() =>
          Effect.logInfo("Checked who is signed in to the browser profiles.", {
            sessions: accounts.sessions().length,
            live: accounts.sessions().filter((session) => session.live).length,
          }),
        ),
      ),
      Effect.ignore,
      Effect.forkDetach,
    );
  });

  const setDownloadDirectory = Effect.fn("BrowserSession.setDownloadDirectory")(function* (
    scope: string,
    directory: string,
    threadId?: string,
  ) {
    const partition = yield* getPartition(scope);
    downloadDirectories.set(partition, directory);
    if (threadId !== undefined) {
      threadDownloadDirectories.set(`${partition}\u0000${threadId}`, directory);
    }
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
    forgetDownloadDomains: () => {
      if (allowedDownloadDomains.size === 0) return;
      allowedDownloadDomains.clear();
      persistAllowedDownloadDomains();
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
    reconcileProfiles,
    accounts,
    profileKind: (directory) => manifest().profiles[directory]?.kind ?? null,
    maintainProfiles: () =>
      sweepProfiles().pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Could not sweep browser profiles.", { cause }),
        ),
        Effect.andThen(Effect.tryPromise(() => accounts.refreshAll()).pipe(Effect.ignore)),
      ),
    profileCounts: () => {
      const entries = NodeFS.existsSync(partitionsDir()) ? NodeFS.readdirSync(partitionsDir()) : [];
      return {
        profiles: Object.keys(manifest().profiles).length,
        retired: entries.filter((name) => name.includes(".retired-")).length,
        encrypted: manifest().encryptedJars.length,
      };
    },
    directoryForScope: (scope) => getPartition(scope).pipe(Effect.map(directoryOfPartition)),
    onAccountEvent: (listener) => {
      accountEventListeners.add(listener);
    },
    noteGuestThread: (webContentsId, threadId) => {
      if (threadId === null) guestThreads.delete(webContentsId);
      else guestThreads.set(webContentsId, threadId);
    },
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
