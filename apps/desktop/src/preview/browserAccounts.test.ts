// @effect-diagnostics nodeBuiltinImport:off - Exercises the real account log on disk.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import type { Cookie, Session } from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { PreviewAccountEvent, PreviewAccountOwner } from "@t3tools/contracts";

import {
  cookieSetDetails,
  makeBrowserAccountTracker,
  providerForCookieDomain,
  rewriteStoredCookies,
  type BrowserAccountTracker,
} from "./browserAccounts.ts";
import type { BrowserAccountLink } from "./browserProfiles.ts";

type ChangedListener = (event: unknown, cookie: Cookie, cause: string, removed: boolean) => void;

const cookie = (overrides: Partial<Cookie> & { name: string; domain: string }): Cookie =>
  ({
    value: "value",
    path: "/",
    secure: true,
    httpOnly: true,
    session: false,
    ...overrides,
  }) as Cookie;

function fakeSession(initial: ReadonlyArray<Cookie> = [], accountList = '["x",[]]') {
  let jar = [...initial];
  const listeners: Array<ChangedListener> = [];
  const session = {
    cookies: {
      on: (_event: string, listener: ChangedListener) => {
        listeners.push(listener);
      },
      get: vi.fn(async (filter: { name?: string; domain?: string }) =>
        jar.filter(
          (entry) =>
            (filter.name === undefined || entry.name === filter.name) &&
            (filter.domain === undefined || entry.domain === filter.domain),
        ),
      ),
      set: vi.fn(async (details: { name: string; value?: string; domain?: string }) => {
        jar = [
          ...jar.filter((entry) => entry.name !== details.name),
          cookie({
            name: details.name,
            value: details.value ?? "",
            domain: details.domain ?? "host-only.example",
          }),
        ];
      }),
      remove: vi.fn(async (_url: string, name: string) => {
        jar = jar.filter((entry) => entry.name !== name);
      }),
      flushStore: vi.fn(async () => undefined),
    },
    fetch: vi.fn(async () => new Response(accountList, { status: 200 })),
  };
  return {
    session: session as unknown as Session,
    raw: session,
    jar: () => jar,
    emit: (changed: Cookie, cause: string, removed: boolean) => {
      for (const listener of listeners) listener({}, changed, cause, removed);
    },
  };
}

const googleRow = (email: string, valid: number, signedOut: number | null) => {
  const row: Array<unknown> = Array.from({ length: 17 }, () => null);
  row[3] = email;
  row[9] = valid;
  row[14] = signedOut;
  return row;
};

const googleList = (...rows: ReadonlyArray<ReadonlyArray<unknown>>) =>
  JSON.stringify(["gaia.l.a.r", rows]);

const SID = cookie({ name: "SID", domain: ".google.com", value: "session-secret" });
const OWNER: PreviewAccountOwner = { environmentId: "env", kind: "project", ownerId: "project-a" };

let logDirectory: string;
let events: Array<PreviewAccountEvent>;
let links: Array<BrowserAccountLink>;

function makeTracker(openable: Readonly<Record<string, Session>> = {}): BrowserAccountTracker {
  return makeBrowserAccountTracker({
    logPath: NodePath.join(logDirectory, "accounts.ndjson"),
    ownerOf: () => OWNER,
    linksOf: () => links,
    addLink: (link) => links.push(link),
    removeLink: (provider, directory) => {
      links = links.filter(
        (link) => link.provider !== provider || !link.profiles.includes(directory),
      );
    },
    openSession: async (directory) => openable[directory] ?? null,
    onEvent: (event) => events.push(event),
    onFailure: (operation, cause) => {
      throw new Error(`${operation}: ${String(cause)}`);
    },
  });
}

beforeEach(() => {
  logDirectory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "browser-accounts-"));
  events = [];
  links = [];
});

afterEach(() => {
  NodeFS.rmSync(logDirectory, { recursive: true, force: true });
});

describe("providerForCookieDomain", () => {
  it("recognizes a provider's domains and nothing else", () => {
    expect(providerForCookieDomain(".google.com")).toBe("google");
    expect(providerForCookieDomain("accounts.google.com")).toBe("google");
    expect(providerForCookieDomain(".github.com")).toBe("github");
    expect(providerForCookieDomain("login.microsoftonline.com")).toBe("microsoft");
    expect(providerForCookieDomain(".example.com")).toBeNull();
  });
});

describe("cookieSetDetails", () => {
  it("keeps a host-only cookie host-only, or Chromium refuses a __Host- name", () => {
    const details = cookieSetDetails(
      cookie({ name: "__Host-a", domain: "app.example.com", hostOnly: true }),
    );
    expect(details.url).toBe("https://app.example.com/");
    expect(details).not.toHaveProperty("domain");
  });

  it("keeps a domain cookie's domain and expiry", () => {
    const details = cookieSetDetails(
      cookie({ name: "a", domain: ".example.com", expirationDate: 123, sameSite: "lax" }),
    );
    expect(details).toMatchObject({
      url: "https://example.com/",
      domain: ".example.com",
      expirationDate: 123,
      sameSite: "lax",
    });
  });
});

describe("who is signed in", () => {
  it("reads Google's own answer, including an account it has signed out", async () => {
    const fake = fakeSession(
      [SID],
      googleList(googleRow("work@example.com", 1, null), googleRow("old@example.com", 0, 1)),
    );
    const tracker = makeTracker();
    tracker.attach("profile-a", fake.session);
    await tracker.refresh("profile-a");

    expect(
      tracker.sessions().map((session) => [session.provider, session.identity, session.live]),
    ).toEqual([
      ["google", "work@example.com", true],
      ["google", "old@example.com", false],
    ]);
    expect(tracker.hasLiveAccount("profile-a", "google")).toBe(true);
  });

  it("names a GitHub account from its cookie", async () => {
    const fake = fakeSession([
      cookie({ name: "logged_in", domain: ".github.com", value: "yes" }),
      cookie({ name: "dotcom_user", domain: ".github.com", value: "octocat" }),
    ]);
    const tracker = makeTracker();
    tracker.attach("profile-a", fake.session);
    await tracker.refresh("profile-a");
    expect(tracker.sessions()).toMatchObject([{ provider: "github", identity: "octocat" }]);
  });

  it("keeps what it knows when Google's check fails", async () => {
    const fake = fakeSession([SID], googleList(googleRow("work@example.com", 1, null)));
    const tracker = makeTracker();
    tracker.attach("profile-a", fake.session);
    await tracker.refresh("profile-a");
    fake.raw.fetch.mockResolvedValueOnce(new Response("", { status: 500 }));
    await tracker.refresh("profile-a");
    expect(tracker.hasLiveAccount("profile-a", "google")).toBe(true);
  });

  it("records a session Google ended even though its cookies are still there", async () => {
    const fake = fakeSession([SID], googleList(googleRow("work@example.com", 1, null)));
    const tracker = makeTracker();
    tracker.attach("profile-a", fake.session);
    await tracker.refresh("profile-a");
    fake.raw.fetch.mockResolvedValueOnce(
      new Response(googleList(googleRow("work@example.com", 0, null)), { status: 200 }),
    );
    await tracker.refresh("profile-a");
    expect(events).toMatchObject([
      { reason: "session-ended", provider: "google", identity: "work@example.com" },
    ]);
  });

  it("offers the project with the most accounts, naming all of them", async () => {
    const one = fakeSession([SID], googleList(googleRow("solo@example.com", 1, null)));
    const two = fakeSession(
      [SID],
      googleList(
        googleRow("work@example.com", 1, null),
        googleRow("home@example.com", 1, null),
        googleRow("old@example.com", 0, 1),
      ),
    );
    const tracker = makeTracker();
    tracker.attach("one", one.session);
    tracker.attach("two", two.session);
    await tracker.refresh("one");
    await tracker.refresh("two");
    expect(tracker.findLiveElsewhere("here", "google")).toMatchObject({
      directory: "two",
      identity: "work@example.com, home@example.com",
    });
  });

  it("offers a project's account to another profile, but never an agent's", async () => {
    const project = fakeSession([SID], googleList(googleRow("work@example.com", 1, null)));
    const tracker = makeBrowserAccountTracker({
      logPath: NodePath.join(logDirectory, "accounts.ndjson"),
      ownerOf: (directory) => ({
        environmentId: "env",
        kind: directory === "agent" ? "agent" : "project",
        ownerId: directory,
      }),
      linksOf: () => links,
      addLink: () => undefined,
      removeLink: () => undefined,
      openSession: async () => null,
      onEvent: () => undefined,
      onFailure: () => undefined,
    });
    tracker.attach("agent", project.session);
    await tracker.refresh("agent");
    expect(tracker.findLiveElsewhere("here", "google")).toBeNull();

    const second = fakeSession([SID], googleList(googleRow("work@example.com", 1, null)));
    tracker.attach("project-a", second.session);
    await tracker.refresh("project-a");
    expect(tracker.findLiveElsewhere("here", "google")).toMatchObject({
      directory: "project-a",
      identity: "work@example.com",
    });
  });
});

describe("sign-out log", () => {
  it("records a removed session cookie with its cause and no cookie value", async () => {
    const fake = fakeSession([SID], googleList(googleRow("work@example.com", 1, null)));
    const tracker = makeTracker();
    tracker.attach("profile-a", fake.session);
    await tracker.refresh("profile-a");

    fake.emit(SID, "expired", true);

    expect(events).toMatchObject([
      {
        reason: "signed-out",
        provider: "google",
        identity: "work@example.com",
        directory: "profile-a",
        cookieCause: "expired",
      },
    ]);
    const log = NodeFS.readFileSync(NodePath.join(logDirectory, "accounts.ndjson"), "utf8");
    expect(log).toContain("signed-out");
    expect(log).not.toContain("session-secret");
  });

  it("does not read a rotation as a sign-out", () => {
    const fake = fakeSession([SID]);
    const tracker = makeTracker();
    tracker.attach("profile-a", fake.session);
    fake.emit(SID, "overwrite", true);
    expect(events).toEqual([]);
  });

  it("ignores other sites' cookies entirely", () => {
    const fake = fakeSession();
    const tracker = makeTracker();
    tracker.attach("profile-a", fake.session);
    fake.emit(cookie({ name: "SID", domain: ".example.com" }), "explicit", true);
    expect(events).toEqual([]);
  });

  it("reloads recent events after a restart", () => {
    const fake = fakeSession([SID]);
    const tracker = makeTracker();
    tracker.attach("profile-a", fake.session);
    fake.emit(SID, "explicit", true);
    expect(makeTracker().recentEvents()).toMatchObject([{ reason: "signed-out" }]);
  });
});

describe("linked accounts", () => {
  const other = cookie({ name: "other-site", domain: ".example.com", value: "private" });

  it("copies only that provider's cookies and remembers the link", async () => {
    const from = fakeSession([SID, other], googleList(googleRow("work@example.com", 1, null)));
    const to = fakeSession([], googleList(googleRow("work@example.com", 1, null)));
    const tracker = makeTracker();
    tracker.attach("from", from.session);
    tracker.attach("to", to.session);

    await tracker.link("google", "from", "to");

    expect(to.jar().map((entry) => entry.name)).toEqual(["SID"]);
    expect(links).toEqual([{ provider: "google", profiles: ["from", "to"] }]);
    expect(tracker.hasLiveAccount("to", "google")).toBe(true);
  });

  it("carries a rotated session cookie across, and does not echo it back", async () => {
    const from = fakeSession([SID]);
    const to = fakeSession();
    const tracker = makeTracker();
    tracker.attach("from", from.session);
    tracker.attach("to", to.session);
    links = [{ provider: "google", profiles: ["from", "to"] }];

    const rotated = { ...SID, value: "rotated" };
    from.emit(rotated, "explicit", false);
    await vi.waitFor(() => expect(to.raw.cookies.set).toHaveBeenCalledTimes(1));

    to.emit(rotated, "explicit", false);
    await new Promise((resolve) => setImmediate(resolve));
    expect(from.raw.cookies.set).not.toHaveBeenCalled();
  });

  it("carries a deliberate sign-out across, but lets an expiry stay local", async () => {
    const from = fakeSession([SID]);
    const to = fakeSession([SID]);
    const tracker = makeTracker();
    tracker.attach("from", from.session);
    tracker.attach("to", to.session);
    links = [{ provider: "google", profiles: ["from", "to"] }];

    from.emit(SID, "expired", true);
    await new Promise((resolve) => setImmediate(resolve));
    expect(to.raw.cookies.remove).not.toHaveBeenCalled();

    from.emit(SID, "explicit", true);
    await vi.waitFor(() => expect(to.raw.cookies.remove).toHaveBeenCalledTimes(1));
  });

  it("signing out clears only that provider, ends the link and tells the site", async () => {
    const fake = fakeSession([SID, other]);
    const tracker = makeTracker();
    tracker.attach("from", fake.session);
    links = [{ provider: "google", profiles: ["from", "to"] }];

    await tracker.signOut("google", "from");

    expect(fake.jar().map((entry) => entry.name)).toEqual(["other-site"]);
    expect(links).toEqual([]);
    expect(fake.raw.fetch).toHaveBeenCalledWith(
      "https://accounts.google.com/Logout",
      expect.objectContaining({ credentials: "include" }),
    );
  });
});

describe("rewriteStoredCookies", () => {
  it("rewrites every cookie and flushes, counting what Chromium refuses", async () => {
    const fake = fakeSession([SID, cookie({ name: "bad", domain: ".example.com" })]);
    fake.raw.cookies.set.mockImplementationOnce(async () => undefined);
    fake.raw.cookies.set.mockImplementationOnce(async () => {
      throw new Error("refused");
    });
    await expect(rewriteStoredCookies(fake.session)).resolves.toEqual({ rewritten: 1, failed: 1 });
    expect(fake.raw.cookies.flushStore).toHaveBeenCalled();
  });
});
