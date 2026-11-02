// @effect-diagnostics nodeBuiltinImport:off globalDate:off - Exercises real cookie files on disk.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import {
  EMPTY_PROFILE_MANIFEST,
  PROFILE_MANIFEST_FILE,
  RETIRED_PROFILE_RETENTION_MS,
  UNOWNED_PROFILE_MIN_AGE_MS,
  agentProfileScope,
  applyProfileSweep,
  cookieSiteGroup,
  countPlaintextCookies,
  foldThreadProfilesIntoProjects,
  parseGoogleAccountList,
  planProfileSweep,
  profileDirectoryForScope,
  projectProfileScope,
  readProfileManifest,
  type BrowserProfileInventory,
  type GoogleSessionProbe,
} from "./browserProfiles.ts";

const ENVIRONMENT = "env-1";
const FILETIME_OFFSET_MS = 11_644_473_600_000;
const NOW = 1_800_000_000_000;

let partitionsDir: string;

interface SeedCookie {
  readonly host: string;
  readonly name: string;
  readonly value: string;
  readonly seenMs: number;
}

function seedJar(directory: string, cookies: ReadonlyArray<SeedCookie>): void {
  const profile = NodePath.join(partitionsDir, directory);
  NodeFS.mkdirSync(profile, { recursive: true });
  const database = new NodeSqlite.DatabaseSync(NodePath.join(profile, "Cookies"));
  database.exec(`CREATE TABLE IF NOT EXISTS cookies (
    host_key TEXT NOT NULL, name TEXT NOT NULL, path TEXT NOT NULL,
    value TEXT NOT NULL, encrypted_value BLOB NOT NULL DEFAULT x'',
    last_access_utc INTEGER NOT NULL,
    UNIQUE (host_key, name, path))`);
  const insert = database.prepare(
    "INSERT OR REPLACE INTO cookies (host_key, name, path, value, last_access_utc) VALUES (?, ?, '/', ?, ?)",
  );
  for (const cookie of cookies) {
    insert.run(
      cookie.host,
      cookie.name,
      cookie.value,
      (cookie.seenMs + FILETIME_OFFSET_MS) * 1_000,
    );
  }
  database.close();
}

function cookiesIn(
  directory: string,
): ReadonlyArray<{ host_key: string; name: string; value: string }> {
  const database = new NodeSqlite.DatabaseSync(NodePath.join(partitionsDir, directory, "Cookies"), {
    readOnly: true,
  });
  try {
    return database
      .prepare("SELECT host_key, name, value FROM cookies ORDER BY host_key, name")
      .all() as unknown as ReadonlyArray<{ host_key: string; name: string; value: string }>;
  } finally {
    database.close();
  }
}

const threadDirectory = (threadId: string) =>
  profileDirectoryForScope(agentProfileScope(ENVIRONMENT, threadId));
const projectDirectory = (projectId: string) =>
  profileDirectoryForScope(projectProfileScope(ENVIRONMENT, projectId));

const inventory = (overrides: Partial<BrowserProfileInventory> = {}): BrowserProfileInventory => ({
  environmentId: ENVIRONMENT,
  projects: [{ projectId: "project-a", threadIds: ["thread-1", "thread-2"] }],
  agentRootThreadIds: [],
  hostedEnvironmentIds: [ENVIRONMENT],
  ...overrides,
});

const noLiveGoogle: GoogleSessionProbe = async () => ({ liveAccounts: 0 });

beforeEach(() => {
  partitionsDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "browser-profiles-"));
});

afterEach(() => {
  NodeFS.rmSync(partitionsDir, { recursive: true, force: true });
});

describe("cookieSiteGroup", () => {
  it("groups subdomains and keeps Google's domains together", () => {
    expect(cookieSiteGroup(".app.example.com")).toBe("example.com");
    expect(cookieSiteGroup("www.example.co.uk")).toBe("example.co.uk");
    expect(cookieSiteGroup(".google.com")).toBe("google");
    expect(cookieSiteGroup("accounts.google.com")).toBe("google");
    expect(cookieSiteGroup(".youtube.com")).toBe("google");
    expect(cookieSiteGroup("localhost")).toBe("localhost");
  });
});

describe("parseGoogleAccountList", () => {
  const row = (email: string, valid: number, signedOut: number | null) => {
    const account: Array<unknown> = Array.from({ length: 17 }, () => null);
    account[3] = email;
    account[9] = valid;
    account[14] = signedOut;
    return account;
  };

  it("reports a remembered but signed out account as not live", () => {
    const body = JSON.stringify([
      "gaia.l.a.r",
      [row("work@example.com", 1, null), row("old@example.com", 0, 1)],
    ]);
    expect(parseGoogleAccountList(body)).toEqual([
      { email: "work@example.com", live: true },
      { email: "old@example.com", live: false },
    ]);
  });
});

describe("foldThreadProfilesIntoProjects", () => {
  it("merges a project's thread folders, keeping the freshest sign-in per site", async () => {
    seedJar(threadDirectory("thread-1"), [
      { host: ".site-a.com", name: "session", value: "older", seenMs: NOW - 5_000 },
      { host: ".site-b.com", name: "session", value: "only-in-1", seenMs: NOW - 5_000 },
    ]);
    seedJar(threadDirectory("thread-2"), [
      { host: ".site-a.com", name: "session", value: "newer", seenMs: NOW - 1_000 },
    ]);

    const result = await foldThreadProfilesIntoProjects({
      partitionsDir,
      inventory: inventory(),
      manifest: EMPTY_PROFILE_MANIFEST,
      openDirectories: new Set(),
      probeGoogle: noLiveGoogle,
      nowMs: NOW,
    });

    const target = projectDirectory("project-a");
    expect(cookiesIn(target)).toEqual([
      { host_key: ".site-a.com", name: "session", value: "newer" },
      { host_key: ".site-b.com", name: "session", value: "only-in-1" },
    ]);
    expect(result.manifest.migratedEnvironments).toEqual([ENVIRONMENT]);
    expect(result.manifest.profiles[target]).toEqual({
      environmentId: ENVIRONMENT,
      kind: "project",
      ownerId: "project-a",
    });
    expect(NodeFS.existsSync(NodePath.join(partitionsDir, threadDirectory("thread-1")))).toBe(
      false,
    );
    expect(NodeFS.existsSync(NodePath.join(partitionsDir, threadDirectory("thread-2")))).toBe(
      false,
    );
    const retired = NodeFS.readdirSync(partitionsDir).filter((name) => name.includes(".retired-"));
    expect(retired).toHaveLength(1);
  });

  it("takes Google from the folder Google says is signed in, not the newest one", async () => {
    seedJar(threadDirectory("thread-1"), [
      { host: ".google.com", name: "SID", value: "live-session", seenMs: NOW - 90_000 },
      { host: ".youtube.com", name: "LOGIN_INFO", value: "live-yt", seenMs: NOW - 90_000 },
    ]);
    seedJar(threadDirectory("thread-2"), [
      { host: ".google.com", name: "SID", value: "dead-session", seenMs: NOW - 1_000 },
      { host: ".youtube.com", name: "LOGIN_INFO", value: "dead-yt", seenMs: NOW - 1_000 },
    ]);

    await foldThreadProfilesIntoProjects({
      partitionsDir,
      inventory: inventory(),
      manifest: EMPTY_PROFILE_MANIFEST,
      openDirectories: new Set(),
      probeGoogle: async (header) => ({ liveAccounts: header.includes("live-session") ? 1 : 0 }),
      nowMs: NOW,
    });

    expect(cookiesIn(projectDirectory("project-a"))).toEqual([
      { host_key: ".google.com", name: "SID", value: "live-session" },
      { host_key: ".youtube.com", name: "LOGIN_INFO", value: "live-yt" },
    ]);
  });

  it("takes nothing from a deleted thread's folder, and asks Google nothing about it", async () => {
    const asked: Array<string> = [];
    seedJar("t3code-preview-" + "a".repeat(20), [
      { host: ".google.com", name: "SID", value: "orphan-session", seenMs: NOW - 1_000 },
    ]);

    await foldThreadProfilesIntoProjects({
      partitionsDir,
      inventory: inventory({ projects: [{ projectId: "project-a", threadIds: [] }] }),
      manifest: EMPTY_PROFILE_MANIFEST,
      openDirectories: new Set(),
      probeGoogle: async (header) => {
        asked.push(header);
        return { liveAccounts: 1 };
      },
      nowMs: NOW,
    });

    expect(asked).toEqual([]);
    expect(NodeFS.existsSync(NodePath.join(partitionsDir, projectDirectory("project-a")))).toBe(
      false,
    );
  });

  it("leaves an agent's folder alone and records it as the agent's", async () => {
    const agentDirectory = threadDirectory("agent-thread");
    seedJar(agentDirectory, [
      { host: ".site-a.com", name: "session", value: "agent", seenMs: NOW },
    ]);

    const result = await foldThreadProfilesIntoProjects({
      partitionsDir,
      inventory: inventory({
        projects: [{ projectId: "project-a", threadIds: [] }],
        agentRootThreadIds: ["agent-thread"],
      }),
      manifest: EMPTY_PROFILE_MANIFEST,
      openDirectories: new Set(),
      probeGoogle: noLiveGoogle,
      nowMs: NOW,
    });

    expect(cookiesIn(agentDirectory)).toEqual([
      { host_key: ".site-a.com", name: "session", value: "agent" },
    ]);
    expect(result.manifest.profiles[agentDirectory]).toEqual({
      environmentId: ENVIRONMENT,
      kind: "agent",
      ownerId: "agent-thread",
    });
  });

  it("never replaces a project folder that already exists", async () => {
    seedJar(projectDirectory("project-a"), [
      { host: ".site-a.com", name: "session", value: "current", seenMs: NOW },
    ]);
    seedJar(threadDirectory("thread-1"), [
      { host: ".site-a.com", name: "session", value: "stale", seenMs: NOW + 5_000 },
    ]);

    await foldThreadProfilesIntoProjects({
      partitionsDir,
      inventory: inventory(),
      manifest: EMPTY_PROFILE_MANIFEST,
      openDirectories: new Set(),
      probeGoogle: noLiveGoogle,
      nowMs: NOW,
    });

    expect(cookiesIn(projectDirectory("project-a"))).toEqual([
      { host_key: ".site-a.com", name: "session", value: "current" },
    ]);
  });

  it("asks Google about a copied session only once", async () => {
    const asked: Array<string> = [];
    for (const thread of ["thread-1", "thread-2"]) {
      seedJar(threadDirectory(thread), [
        { host: ".google.com", name: "SID", value: "same-session", seenMs: NOW },
      ]);
    }
    await foldThreadProfilesIntoProjects({
      partitionsDir,
      inventory: inventory(),
      manifest: EMPTY_PROFILE_MANIFEST,
      openDirectories: new Set(),
      probeGoogle: async (header) => {
        asked.push(header);
        return { liveAccounts: 0 };
      },
      nowMs: NOW,
    });
    expect(asked).toHaveLength(1);
  });
});

describe("planProfileSweep", () => {
  const unowned = "t3code-preview-" + "b".repeat(20);
  const inventories = () => new Map([[ENVIRONMENT, inventory()]]);
  const migrated = { ...EMPTY_PROFILE_MANIFEST, migratedEnvironments: [ENVIRONMENT] };
  const age = (directory: string, ageMs: number) => {
    const time = new Date(NOW - ageMs);
    const profile = NodePath.join(partitionsDir, directory);
    NodeFS.utimesSync(NodePath.join(profile, "Cookies"), time, time);
  };

  it("retires a folder whose project is gone and forgets its record once it moves", () => {
    const directory = projectDirectory("project-gone");
    seedJar(directory, [{ host: ".site.com", name: "a", value: "b", seenMs: NOW }]);
    const manifest = {
      ...migrated,
      profiles: {
        [directory]: { environmentId: ENVIRONMENT, kind: "project", ownerId: "project-gone" },
      },
      accountLinks: [{ provider: "google", profiles: [directory, "other"] }],
    } as typeof migrated;
    const plan = planProfileSweep({
      partitionsDir,
      manifest,
      inventories: inventories(),
      hostedEnvironmentIds: [ENVIRONMENT],
      openDirectories: new Set(),
      nowMs: NOW,
    });
    expect(plan.retire).toEqual([directory]);

    const applied = applyProfileSweep({
      partitionsDir,
      manifest,
      plan,
      nowMs: NOW,
      purgeEnabled: true,
    });
    expect(applied.manifest.profiles[directory]).toBeUndefined();
    expect(applied.manifest.accountLinks).toEqual([]);
    expect(NodeFS.existsSync(NodePath.join(partitionsDir, directory))).toBe(false);
  });

  it("keeps a folder for an environment that has not reported yet", () => {
    const directory = projectDirectory("project-elsewhere");
    seedJar(directory, [{ host: ".site.com", name: "a", value: "b", seenMs: NOW }]);
    const plan = planProfileSweep({
      partitionsDir,
      manifest: {
        ...migrated,
        profiles: {
          [directory]: { environmentId: "env-2", kind: "project", ownerId: "project-elsewhere" },
        },
      },
      inventories: inventories(),
      hostedEnvironmentIds: [ENVIRONMENT, "env-2"],
      openDirectories: new Set(),
      nowMs: NOW,
    });
    expect(plan.retire).toEqual([]);
  });

  it("waits on an unowned folder until every environment is folded and it has gone idle", () => {
    seedJar(unowned, [{ host: ".site.com", name: "a", value: "b", seenMs: NOW }]);
    age(unowned, UNOWNED_PROFILE_MIN_AGE_MS + 1_000);

    const notFolded = planProfileSweep({
      partitionsDir,
      manifest: migrated,
      inventories: inventories(),
      hostedEnvironmentIds: [ENVIRONMENT, "env-2"],
      openDirectories: new Set(),
      nowMs: NOW,
    });
    expect(notFolded.retire).toEqual([]);

    const folded = planProfileSweep({
      partitionsDir,
      manifest: migrated,
      inventories: inventories(),
      hostedEnvironmentIds: [ENVIRONMENT],
      openDirectories: new Set(),
      nowMs: NOW,
    });
    expect(folded.retire).toEqual([unowned]);
  });

  it("does not retire a recently used unowned folder, or one that is open", () => {
    seedJar(unowned, [{ host: ".site.com", name: "a", value: "b", seenMs: NOW }]);
    age(unowned, 1_000);
    expect(
      planProfileSweep({
        partitionsDir,
        manifest: migrated,
        inventories: inventories(),
        hostedEnvironmentIds: [ENVIRONMENT],
        openDirectories: new Set(),
        nowMs: NOW,
      }).retire,
    ).toEqual([]);

    age(unowned, UNOWNED_PROFILE_MIN_AGE_MS + 1_000);
    expect(
      planProfileSweep({
        partitionsDir,
        manifest: migrated,
        inventories: inventories(),
        hostedEnvironmentIds: [ENVIRONMENT],
        openDirectories: new Set([unowned]),
        nowMs: NOW,
      }).retire,
    ).toEqual([]);
  });

  it("purges retired folders only after their window, and never when cleanup is off", () => {
    const expired = `${unowned}.retired-${NOW - RETIRED_PROFILE_RETENTION_MS - 1}`;
    const recent = `${unowned}.retired-${NOW - 1_000}`;
    NodeFS.mkdirSync(NodePath.join(partitionsDir, expired));
    NodeFS.mkdirSync(NodePath.join(partitionsDir, recent));
    const plan = planProfileSweep({
      partitionsDir,
      manifest: migrated,
      inventories: inventories(),
      hostedEnvironmentIds: [ENVIRONMENT],
      openDirectories: new Set(),
      nowMs: NOW,
    });
    expect(plan.purge).toEqual([expired]);

    applyProfileSweep({ partitionsDir, manifest: migrated, plan, nowMs: NOW, purgeEnabled: false });
    expect(NodeFS.existsSync(NodePath.join(partitionsDir, expired))).toBe(true);

    applyProfileSweep({ partitionsDir, manifest: migrated, plan, nowMs: NOW, purgeEnabled: true });
    expect(NodeFS.existsSync(NodePath.join(partitionsDir, expired))).toBe(false);
    expect(NodeFS.existsSync(NodePath.join(partitionsDir, recent))).toBe(true);
  });

  it("ignores anything that does not look like a profile", () => {
    NodeFS.mkdirSync(NodePath.join(partitionsDir, "something-else"));
    NodeFS.writeFileSync(NodePath.join(partitionsDir, PROFILE_MANIFEST_FILE), "{}");
    const plan = planProfileSweep({
      partitionsDir,
      manifest: migrated,
      inventories: inventories(),
      hostedEnvironmentIds: [ENVIRONMENT],
      openDirectories: new Set(),
      nowMs: NOW,
    });
    expect(plan).toEqual({ retire: [], purge: [], forget: [] });
  });
});

describe("cookie verification helpers", () => {
  it("counts rows still stored in plain text", () => {
    seedJar(threadDirectory("thread-1"), [
      { host: ".site.com", name: "a", value: "plain", seenMs: NOW },
      { host: ".site.com", name: "b", value: "", seenMs: NOW },
    ]);
    expect(countPlaintextCookies(partitionsDir, threadDirectory("thread-1"))).toBe(1);
  });

  it("treats an unreadable manifest as nothing migrated yet", () => {
    NodeFS.writeFileSync(NodePath.join(partitionsDir, PROFILE_MANIFEST_FILE), "not json");
    expect(readProfileManifest(partitionsDir)).toEqual(EMPTY_PROFILE_MANIFEST);
  });
});
