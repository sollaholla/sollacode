// @effect-diagnostics nodeBuiltinImport:off - Offline cookie-jar maintenance runs before Chromium opens a profile.
// @effect-diagnostics globalDate:off - Retention stamps are written from synchronous filesystem paths.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";

/**
 * Browser profiles on disk: which folder belongs to which project or agent, the
 * one-time fold of the old per-thread folders into per-project ones, and the
 * retirement of folders nothing owns any more.
 *
 * Everything here runs while Chromium does not have the folder open, so it may
 * read and rewrite the cookie database directly.
 */

export const PROFILE_DIRECTORY_PREFIX = "t3code-preview-";
const PROFILE_DIRECTORY = /^t3code-preview-[a-f0-9]{20}(?:\.superseded(?:-\d+)?)?$/;
const RETIRED_DIRECTORY = /^t3code-preview-[a-f0-9]{20}(?:\.superseded(?:-\d+)?)?\.retired-(\d+)$/;
export const PROFILE_MANIFEST_FILE = ".t3-browser-profiles.json";

const DAY_MS = 24 * 60 * 60 * 1_000;
/** Long enough to notice a bad fold after an update, short enough not to hoard logins. */
export const RETIRED_PROFILE_RETENTION_MS = 3 * DAY_MS;
/** Holds a folder with no known owner for a day, in case it is in use right now. */
export const UNOWNED_PROFILE_MIN_AGE_MS = DAY_MS;

const WINDOWS_FILETIME_TO_UNIX_MS = 11_644_473_600_000;

/**
 * Typed rows from a prepared statement. Big integers stay as `bigint`: Chromium's
 * timestamps are past `Number.MAX_SAFE_INTEGER`, and reading one as a number throws.
 */
function allRows<Row>(statement: StatementSync, ...parameters: ReadonlyArray<string>) {
  statement.setReadBigInts(true);
  return statement.all(...parameters) as unknown as ReadonlyArray<Row>;
}

export type BrowserProfileKind = "project" | "agent";

export interface BrowserProfileRecord {
  readonly environmentId: string;
  readonly kind: BrowserProfileKind;
  /** The project id, or the agent's main thread id. */
  readonly ownerId: string;
}

/** Two profiles kept signed in to the same account: a change in one reaches the other. */
export interface BrowserAccountLink {
  readonly provider: string;
  readonly profiles: readonly [string, string];
}

export interface BrowserProfileManifest {
  readonly version: 1;
  readonly migratedEnvironments: ReadonlyArray<string>;
  readonly profiles: Readonly<Record<string, BrowserProfileRecord>>;
  /** Jars whose stored cookies have been rewritten through the encrypted store. */
  readonly encryptedJars: ReadonlyArray<string>;
  /** Jars to scrub of leftover plain text before Chromium next opens them. */
  readonly pendingScrub: ReadonlyArray<string>;
  readonly accountLinks: ReadonlyArray<BrowserAccountLink>;
}

export const EMPTY_PROFILE_MANIFEST: BrowserProfileManifest = {
  version: 1,
  migratedEnvironments: [],
  profiles: {},
  encryptedJars: [],
  pendingScrub: [],
  accountLinks: [],
};

export interface BrowserProfileInventory {
  readonly environmentId: string;
  readonly projects: ReadonlyArray<{
    readonly projectId: string;
    readonly threadIds: ReadonlyArray<string>;
  }>;
  readonly agentRootThreadIds: ReadonlyArray<string>;
  /** Every environment this desktop hosts browsers for, reported or not. */
  readonly hostedEnvironmentIds: ReadonlyArray<string>;
}

export function projectProfileScope(environmentId: string, projectId: string): string {
  return `${environmentId}:project:${projectId}`;
}

export function agentProfileScope(environmentId: string, rootThreadId: string): string {
  return `${environmentId}:thread:${rootThreadId}`;
}

/** The folder Chromium uses for a scope; must match `BrowserSession.getPartition`. */
export function profileDirectoryForScope(scope: string): string {
  const digest = NodeCrypto.createHash("sha256").update(scope).digest("hex");
  return `${PROFILE_DIRECTORY_PREFIX}${digest.slice(0, 20)}`;
}

/** The manifest record a scope's folder should carry, or null for the environment's own jar. */
export function profileRecordForScope(scope: string): BrowserProfileRecord | null {
  const match = /^(.+?):(project|thread):(.+)$/.exec(scope);
  if (!match) return null;
  const [, environmentId, kind, ownerId] = match;
  if (environmentId === undefined || ownerId === undefined) return null;
  return { environmentId, kind: kind === "project" ? "project" : "agent", ownerId };
}

export function readProfileManifest(partitionsDir: string): BrowserProfileManifest {
  try {
    const parsed = JSON.parse(
      NodeFS.readFileSync(NodePath.join(partitionsDir, PROFILE_MANIFEST_FILE), "utf8"),
    ) as Partial<BrowserProfileManifest>;
    if (parsed.version !== 1) return EMPTY_PROFILE_MANIFEST;
    return {
      version: 1,
      migratedEnvironments: parsed.migratedEnvironments ?? [],
      profiles: parsed.profiles ?? {},
      encryptedJars: parsed.encryptedJars ?? [],
      pendingScrub: parsed.pendingScrub ?? [],
      accountLinks: parsed.accountLinks ?? [],
    };
  } catch {
    // Missing or unreadable reads as "nothing migrated yet"; the fold never
    // overwrites a populated target, so running it again cannot lose a login.
    return EMPTY_PROFILE_MANIFEST;
  }
}

export function writeProfileManifest(
  partitionsDir: string,
  manifest: BrowserProfileManifest,
): void {
  NodeFS.mkdirSync(partitionsDir, { recursive: true });
  const target = NodePath.join(partitionsDir, PROFILE_MANIFEST_FILE);
  const staging = `${target}.tmp`;
  NodeFS.writeFileSync(staging, JSON.stringify(manifest, null, 2), { mode: 0o600 });
  NodeFS.renameSync(staging, target);
}

export function cookieJarPath(profileDir: string): string | null {
  for (const relative of [["Cookies"], ["Network", "Cookies"]]) {
    const candidate = NodePath.join(profileDir, ...relative);
    const size = NodeFS.statSync(candidate, { throwIfNoEntry: false })?.size;
    if (size !== undefined && size > 0) return candidate;
  }
  return null;
}

const COMPOUND_SECOND_LEVEL = new Set(["co", "com", "net", "org", "ac", "gov", "edu", "ne", "or"]);

/**
 * Which site a cookie belongs to. Sign-ins are moved whole per site, because a
 * jar holding half of one session and half of another is signed in to nothing.
 * Google's own domains are one sign-in, so they travel together.
 */
export function cookieSiteGroup(hostKey: string): string {
  const host = hostKey.replace(/^\./, "").toLowerCase();
  const labels = host.split(".");
  const last = labels[labels.length - 1] ?? "";
  const secondLast = labels[labels.length - 2] ?? "";
  const site =
    labels.length > 2 && last.length === 2 && COMPOUND_SECOND_LEVEL.has(secondLast)
      ? labels.slice(-3).join(".")
      : labels.slice(-2).join(".");
  return /^(google\.|youtube\.com$|gstatic\.com$)/.test(site) ? "google" : site;
}

function chromeTimeToUnixMs(value: bigint): number {
  const micros = Number(value);
  return micros <= 0 ? 0 : micros / 1_000 - WINDOWS_FILETIME_TO_UNIX_MS;
}

export interface CookieJarSummary {
  readonly directory: string;
  /** Site group -> the last time one of its cookies was read or written. */
  readonly siteActivityMs: ReadonlyMap<string, number>;
  readonly lastActivityMs: number;
  /** Cookies sent to Google's account endpoint; empty when they are encrypted. */
  readonly googleCookieHeader: string | null;
  readonly googleSessionKey: string | null;
}

export function summarizeCookieJar(
  partitionsDir: string,
  directory: string,
): CookieJarSummary | null {
  const jar = cookieJarPath(NodePath.join(partitionsDir, directory));
  if (jar === null) return null;
  const database = new DatabaseSync(jar, { readOnly: true });
  try {
    const siteActivityMs = new Map<string, number>();
    const rows = allRows<{ host_key: string; seen: bigint }>(
      database.prepare(
        "SELECT host_key, MAX(last_access_utc) AS seen FROM cookies GROUP BY host_key",
      ),
    );
    let lastActivityMs = 0;
    for (const row of rows) {
      const group = cookieSiteGroup(row.host_key);
      const seenMs = chromeTimeToUnixMs(row.seen);
      if (seenMs > (siteActivityMs.get(group) ?? 0)) siteActivityMs.set(group, seenMs);
      if (seenMs > lastActivityMs) lastActivityMs = seenMs;
    }
    const google = allRows<{ name: string; value: string }>(
      database.prepare(
        `SELECT name, value FROM cookies
         WHERE host_key IN ('.google.com', 'accounts.google.com') AND path = '/' AND value <> ''`,
      ),
    );
    const sid = google.find((cookie) => cookie.name === "SID");
    return {
      directory,
      siteActivityMs,
      lastActivityMs,
      googleCookieHeader:
        sid === undefined
          ? null
          : google.map((cookie) => `${cookie.name}=${cookie.value}`).join("; "),
      googleSessionKey:
        sid === undefined ? null : NodeCrypto.createHash("sha256").update(sid.value).digest("hex"),
    };
  } finally {
    database.close();
  }
}

/**
 * Copy whole sites from one closed jar into another. Column names are
 * intersected because a jar untouched for months can predate a Chromium upgrade
 * that added one; Chromium brings the older schema forward when it opens it.
 */
export function copyCookieSites(input: {
  readonly targetJar: string;
  readonly sourceJar: string;
  readonly groups: ReadonlySet<string>;
}): void {
  if (input.groups.size === 0) return;
  const database = new DatabaseSync(input.targetJar);
  try {
    database.prepare("ATTACH DATABASE ? AS source").run(input.sourceJar);
    const columnsOf = (schema: string) =>
      allRows<{ name: string }>(database.prepare(`PRAGMA ${schema}.table_info(cookies)`)).map(
        (column) => column.name,
      );
    const sourceColumns = new Set(columnsOf("source"));
    const columns = columnsOf("main")
      .filter((name) => sourceColumns.has(name))
      .join(", ");
    const inGroups = (schema: string) =>
      allRows<{ host_key: string }>(
        database.prepare(`SELECT DISTINCT host_key FROM ${schema}.cookies`),
      )
        .map((row) => row.host_key)
        .filter((host) => input.groups.has(cookieSiteGroup(host)));
    const removeHost = database.prepare("DELETE FROM main.cookies WHERE host_key = ?");
    const copyHost = database.prepare(
      `INSERT OR REPLACE INTO main.cookies (${columns})
       SELECT ${columns} FROM source.cookies WHERE host_key = ?`,
    );
    database.exec("BEGIN");
    try {
      for (const host of inGroups("main")) removeHost.run(host);
      for (const host of inGroups("source")) copyHost.run(host);
      database.exec("COMMIT");
    } catch (cause) {
      database.exec("ROLLBACK");
      throw cause;
    }
    database.exec("DETACH DATABASE source");
  } finally {
    database.close();
  }
}

/** Rows still readable in plain text, so a jar's encryption can be verified from outside. */
export function countPlaintextCookies(partitionsDir: string, directory: string): number {
  const jar = cookieJarPath(NodePath.join(partitionsDir, directory));
  if (jar === null) return 0;
  const database = new DatabaseSync(jar, { readOnly: true });
  try {
    const [row] = allRows<{ plain: bigint }>(
      database.prepare("SELECT COUNT(*) AS plain FROM cookies WHERE value <> ''"),
    );
    return Number(row?.plain ?? 0);
  } finally {
    database.close();
  }
}

/**
 * Drop rows still in plain text and reclaim their pages, so the old values do
 * not linger in the file's free space. Only called on a closed jar, and only
 * after its cookies have been rewritten through the encrypted store; anything
 * still plain by then is a cookie Chromium refused to rewrite.
 */
export function scrubPlaintextCookies(partitionsDir: string, directory: string): void {
  const jar = cookieJarPath(NodePath.join(partitionsDir, directory));
  if (jar === null) return;
  const database = new DatabaseSync(jar);
  try {
    database.exec("DELETE FROM cookies WHERE value <> ''");
    database.exec("VACUUM");
  } finally {
    database.close();
  }
}

export interface GoogleAccountProbe {
  /** Accounts Google says are signed in right now. */
  readonly liveAccounts: number;
}

export type GoogleSessionProbe = (cookieHeader: string) => Promise<GoogleAccountProbe | null>;

/**
 * Which account rows Google lists for a session. Each row's index 3 is the
 * email, index 9 is 1 while the session is valid, and index 14 is 1 once that
 * account has been signed out but is still remembered in the chooser.
 */
export function parseGoogleAccountList(body: string): ReadonlyArray<{
  readonly email: string;
  readonly live: boolean;
}> {
  const parsed = JSON.parse(body) as unknown;
  if (!Array.isArray(parsed) || !Array.isArray(parsed[1])) return [];
  return (parsed[1] as ReadonlyArray<unknown>).flatMap((row) => {
    if (!Array.isArray(row)) return [];
    const email = row[3];
    if (typeof email !== "string" || !email.includes("@")) return [];
    return [{ email, live: row[9] === 1 && row[14] !== 1 }];
  });
}

export const GOOGLE_ACCOUNT_LIST_URL =
  "https://accounts.google.com/ListAccounts?gpsia=1&source=ChromiumBrowser&json=standard";

export interface ProfileFoldResult {
  readonly manifest: BrowserProfileManifest;
  readonly folded: ReadonlyArray<{
    readonly projectId: string;
    readonly base: string | null;
    readonly mergedSites: number;
    readonly retired: number;
  }>;
}

function retireDirectory(partitionsDir: string, directory: string, nowMs: number): void {
  const source = NodePath.join(partitionsDir, directory);
  if (!NodeFS.existsSync(source)) return;
  NodeFS.renameSync(source, `${source}.retired-${Math.trunc(nowMs)}`);
}

function bestGoogleSession(
  summaries: ReadonlyArray<CookieJarSummary>,
  liveBySession: ReadonlyMap<string, number>,
): CookieJarSummary | null {
  let best: CookieJarSummary | null = null;
  let bestLive = 0;
  for (const summary of summaries) {
    const live = summary.googleSessionKey ? (liveBySession.get(summary.googleSessionKey) ?? 0) : 0;
    if (
      live > bestLive ||
      (live > 0 && live === bestLive && summary.lastActivityMs > (best?.lastActivityMs ?? 0))
    ) {
      best = summary;
      bestLive = live;
    }
  }
  return best;
}

/**
 * Fold one environment's old per-thread folders into per-project ones.
 *
 * Each project keeps its most recently used thread folder, so that thread's
 * site storage survives. Every other site is taken from whichever of the
 * project's folders used it last, and Google is taken from the folder Google
 * itself says has the most live accounts. A folder from a since-deleted thread
 * cannot be attributed to a project, so it contributes nothing. A project left
 * with no Google session is offered one from another project the first time it
 * needs it, rather than each being handed a copy of the same session now.
 *
 * Folders it replaces are retired, not deleted, for a few days.
 */
export async function foldThreadProfilesIntoProjects(input: {
  readonly partitionsDir: string;
  readonly inventory: BrowserProfileInventory;
  readonly manifest: BrowserProfileManifest;
  readonly openDirectories: ReadonlySet<string>;
  readonly probeGoogle: GoogleSessionProbe;
  readonly nowMs: number;
  /** Bound on how many distinct sessions are checked with Google in one run. */
  readonly maxGoogleProbes?: number;
}): Promise<ProfileFoldResult> {
  const { inventory, partitionsDir, nowMs } = input;
  const environmentId = inventory.environmentId;
  const agentDirectories = new Set(
    inventory.agentRootThreadIds.map((id) =>
      profileDirectoryForScope(agentProfileScope(environmentId, id)),
    ),
  );
  const present = new Set(
    NodeFS.existsSync(partitionsDir)
      ? NodeFS.readdirSync(partitionsDir).filter((name) => PROFILE_DIRECTORY.test(name))
      : [],
  );
  const manifestOwned = new Set(Object.keys(input.manifest.profiles));
  const claimed = new Set<string>([...agentDirectories, ...manifestOwned]);

  const safeSummary = (directory: string): CookieJarSummary | null => {
    try {
      return summarizeCookieJar(partitionsDir, directory);
    } catch {
      // A jar that cannot be read is left where it is rather than guessed at.
      return null;
    }
  };

  const projectJars = inventory.projects.map((project) => {
    const directories = [
      ...new Set(
        project.threadIds.map((id) =>
          profileDirectoryForScope(agentProfileScope(environmentId, id)),
        ),
      ),
    ].filter((name) => present.has(name) && !claimed.has(name));
    for (const directory of directories) claimed.add(directory);
    const summaries = directories.flatMap((directory) => {
      const summary = safeSummary(directory);
      return summary ? [summary] : [];
    });
    return { projectId: project.projectId, directories, summaries };
  });

  // Ask Google about each distinct session once, freshest first, because
  // copying has left the same session in dozens of folders.
  const probeOrder = projectJars
    .flatMap((jar) => jar.summaries)
    .filter((summary) => summary.googleSessionKey !== null && summary.googleCookieHeader !== null)
    .toSorted((left, right) => right.lastActivityMs - left.lastActivityMs);
  const liveBySession = new Map<string, number>();
  const maxProbes = input.maxGoogleProbes ?? 16;
  for (const summary of probeOrder) {
    const key = summary.googleSessionKey;
    if (key === null || liveBySession.has(key)) continue;
    if (liveBySession.size >= maxProbes) break;
    const probe = await input
      .probeGoogle(summary.googleCookieHeader ?? "")
      .catch((): GoogleAccountProbe | null => null);
    liveBySession.set(key, probe?.liveAccounts ?? 0);
  }

  const profiles: Record<string, BrowserProfileRecord> = { ...input.manifest.profiles };
  const folded: Array<ProfileFoldResult["folded"][number]> = [];

  for (const jar of projectJars) {
    const targetName = profileDirectoryForScope(projectProfileScope(environmentId, jar.projectId));
    const target = NodePath.join(partitionsDir, targetName);
    profiles[targetName] = { environmentId, kind: "project", ownerId: jar.projectId };
    if (input.openDirectories.has(targetName) || NodeFS.existsSync(target)) {
      folded.push({ projectId: jar.projectId, base: null, mergedSites: 0, retired: 0 });
      continue;
    }
    const googleSource = bestGoogleSession(jar.summaries, liveBySession);
    const base =
      jar.summaries.toSorted((left, right) => right.lastActivityMs - left.lastActivityMs)[0] ??
      null;
    let mergedSites = 0;
    if (base !== null) {
      // Decide before the rename, while every jar is still in place.
      const chosen = new Map<string, CookieJarSummary>();
      for (const summary of jar.summaries) {
        for (const [group, seenMs] of summary.siteActivityMs) {
          const current = chosen.get(group);
          if (current === undefined || seenMs > (current.siteActivityMs.get(group) ?? 0)) {
            chosen.set(group, summary);
          }
        }
      }
      if (googleSource !== null) chosen.set("google", googleSource);
      NodeFS.renameSync(NodePath.join(partitionsDir, base.directory), target);
      const targetJar = cookieJarPath(target);
      if (targetJar !== null) {
        const bySource = new Map<string, Set<string>>();
        for (const [group, summary] of chosen) {
          if (summary.directory === base.directory) continue;
          const groups = bySource.get(summary.directory) ?? new Set<string>();
          groups.add(group);
          bySource.set(summary.directory, groups);
        }
        for (const [directory, groups] of bySource) {
          const sourceJar = cookieJarPath(NodePath.join(partitionsDir, directory));
          if (sourceJar === null) continue;
          try {
            copyCookieSites({ targetJar, sourceJar, groups });
            mergedSites += groups.size;
          } catch {
            // Those sites ask for a sign-in once; the source stays retired for
            // a few days if it turns out to matter.
          }
        }
      }
    }
    let retired = 0;
    for (const directory of jar.directories) {
      if (directory === base?.directory) continue;
      retireDirectory(partitionsDir, directory, nowMs);
      retired += 1;
    }
    folded.push({ projectId: jar.projectId, base: base?.directory ?? null, mergedSites, retired });
  }

  for (const directory of agentDirectories) {
    if (present.has(directory) || input.openDirectories.has(directory)) {
      const ownerId = inventory.agentRootThreadIds.find(
        (id) => profileDirectoryForScope(agentProfileScope(environmentId, id)) === directory,
      );
      if (ownerId !== undefined) profiles[directory] = { environmentId, kind: "agent", ownerId };
    }
  }

  return {
    manifest: {
      ...input.manifest,
      migratedEnvironments: [...new Set([...input.manifest.migratedEnvironments, environmentId])],
      profiles,
    },
    folded,
  };
}

/** Newest write inside a profile, ignoring the caches that refill on their own. */
function profileActivityMs(profileDir: string): number {
  let newest = 0;
  const visit = (directory: string, depth: number): void => {
    for (const entry of NodeFS.readdirSync(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      if (depth === 0 && (entry.name === "Cache" || entry.name === "Code Cache")) continue;
      const path = NodePath.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (depth < 3) visit(path, depth + 1);
        continue;
      }
      const modified = NodeFS.statSync(path, { throwIfNoEntry: false })?.mtimeMs ?? 0;
      if (modified > newest) newest = modified;
    }
  };
  visit(profileDir, 0);
  return newest;
}

export interface ProfileSweepPlan {
  /** Folders to set aside now. */
  readonly retire: ReadonlyArray<string>;
  /** Set-aside folders whose window has passed. */
  readonly purge: ReadonlyArray<string>;
  /** Owners that are gone: their manifest rows go with the folder. */
  readonly forget: ReadonlyArray<string>;
}

/**
 * Decide what the automatic sweep removes.
 *
 * Owned profiles go when their project or agent is gone. A folder with no record
 * at all is left over from a deleted thread or an old layout; it waits until
 * every hosted environment has been folded, so another environment's unfolded
 * folder is never mistaken for one, and until it has been idle for a while.
 */
export function planProfileSweep(input: {
  readonly partitionsDir: string;
  readonly manifest: BrowserProfileManifest;
  readonly inventories: ReadonlyMap<string, BrowserProfileInventory>;
  readonly hostedEnvironmentIds: ReadonlyArray<string>;
  readonly openDirectories: ReadonlySet<string>;
  readonly nowMs: number;
}): ProfileSweepPlan {
  const { partitionsDir, manifest, nowMs } = input;
  const retire: Array<string> = [];
  const purge: Array<string> = [];
  const forget: Array<string> = [];
  const entries = NodeFS.existsSync(partitionsDir)
    ? NodeFS.readdirSync(partitionsDir, { withFileTypes: true })
    : [];
  const allFolded =
    input.hostedEnvironmentIds.length > 0 &&
    input.hostedEnvironmentIds.every((id) => manifest.migratedEnvironments.includes(id));

  const ownerIsAlive = (record: BrowserProfileRecord): boolean | null => {
    const inventory = input.inventories.get(record.environmentId);
    if (!inventory) return null;
    return record.kind === "project"
      ? inventory.projects.some((project) => project.projectId === record.ownerId)
      : inventory.agentRootThreadIds.includes(record.ownerId);
  };

  for (const [directory, record] of Object.entries(manifest.profiles)) {
    if (ownerIsAlive(record) === false && !input.openDirectories.has(directory)) {
      forget.push(directory);
    }
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const retiredMatch = RETIRED_DIRECTORY.exec(entry.name);
    if (retiredMatch) {
      const retiredAtMs = Number(retiredMatch[1]);
      if (nowMs - retiredAtMs >= RETIRED_PROFILE_RETENTION_MS) purge.push(entry.name);
      continue;
    }
    if (!PROFILE_DIRECTORY.test(entry.name) || input.openDirectories.has(entry.name)) continue;
    if (forget.includes(entry.name)) {
      retire.push(entry.name);
      continue;
    }
    if (manifest.profiles[entry.name] || !allFolded) continue;
    if (entry.name.includes(".superseded")) {
      retire.push(entry.name);
      continue;
    }
    try {
      const idleMs = nowMs - profileActivityMs(NodePath.join(partitionsDir, entry.name));
      if (idleMs >= UNOWNED_PROFILE_MIN_AGE_MS) retire.push(entry.name);
    } catch {
      // Unreadable folders are never cleanup candidates.
    }
  }
  return { retire, purge, forget };
}

/** Apply a sweep plan, one folder at a time so one failure cannot stop the rest. */
export function applyProfileSweep(input: {
  readonly partitionsDir: string;
  readonly manifest: BrowserProfileManifest;
  readonly plan: ProfileSweepPlan;
  readonly nowMs: number;
  readonly purgeEnabled: boolean;
}): {
  readonly manifest: BrowserProfileManifest;
  readonly retired: ReadonlyArray<string>;
  readonly purged: ReadonlyArray<string>;
  readonly failures: ReadonlyArray<{ readonly directory: string; readonly message: string }>;
} {
  const retired: Array<string> = [];
  const purged: Array<string> = [];
  const failures: Array<{ directory: string; message: string }> = [];
  const profiles = { ...input.manifest.profiles };
  for (const directory of input.plan.retire) {
    try {
      retireDirectory(input.partitionsDir, directory, input.nowMs);
      retired.push(directory);
    } catch (cause) {
      failures.push({ directory, message: String(cause) });
    }
  }
  for (const directory of input.plan.forget) {
    if (!NodeFS.existsSync(NodePath.join(input.partitionsDir, directory))) {
      delete profiles[directory];
    }
  }
  if (input.purgeEnabled) {
    for (const directory of input.plan.purge) {
      const target = NodePath.join(input.partitionsDir, directory);
      try {
        // Only ever a real folder directly under Partitions, never a link out of it.
        if (NodeFS.lstatSync(target).isDirectory() && RETIRED_DIRECTORY.test(directory)) {
          NodeFS.rmSync(target, { recursive: true, force: true });
          purged.push(directory);
        }
      } catch (cause) {
        failures.push({ directory, message: String(cause) });
      }
    }
  }
  return {
    manifest: {
      ...input.manifest,
      profiles,
      encryptedJars: input.manifest.encryptedJars.filter((name) => !retired.includes(name)),
      pendingScrub: input.manifest.pendingScrub.filter((name) => !retired.includes(name)),
      accountLinks: input.manifest.accountLinks.filter(
        (link) => !link.profiles.some((name) => retired.includes(name)),
      ),
    },
    retired,
    purged,
    failures,
  };
}
