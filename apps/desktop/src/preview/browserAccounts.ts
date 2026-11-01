// @effect-diagnostics nodeBuiltinImport:off - The account log is appended from synchronous Electron cookie callbacks.
// @effect-diagnostics globalDate:off globalTimers:off - Those same callbacks stamp events and debounce with no Effect context.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import type { Cookie, CookiesSetDetails, Session } from "electron";

import type {
  PreviewAccountEvent,
  PreviewAccountOwner,
  PreviewAccountProvider,
  PreviewAccountSession,
} from "@t3tools/contracts";

import {
  GOOGLE_ACCOUNT_LIST_URL,
  cookieSiteGroup,
  parseGoogleAccountList,
  type BrowserAccountLink,
} from "./browserProfiles.ts";

/**
 * Who is signed in to which browser profile, and when that changes.
 *
 * Sessions are read from each profile's own cookies, plus Google's account list
 * because Google's cookies outlive the session they belong to. Nothing here ever
 * reads or stores a cookie's value except to carry it between two linked
 * profiles of the same person.
 */

interface ProviderDefinition {
  readonly label: string;
  /** Cookie site groups (see `cookieSiteGroup`) that make up this sign-in. */
  readonly groups: ReadonlySet<string>;
  /** A cookie that exists only while signed in. */
  readonly sessionCookie: { readonly domain: string; readonly name: string };
  /** A cookie whose value names the account, when the site has one. */
  readonly identityCookie?: { readonly domain: string; readonly name: string };
  readonly signOutUrl?: string;
}

export const ACCOUNT_PROVIDERS: Readonly<Record<PreviewAccountProvider, ProviderDefinition>> = {
  google: {
    label: "Google",
    groups: new Set(["google"]),
    sessionCookie: { domain: ".google.com", name: "SID" },
    signOutUrl: "https://accounts.google.com/Logout",
  },
  github: {
    label: "GitHub",
    groups: new Set(["github.com"]),
    sessionCookie: { domain: ".github.com", name: "logged_in" },
    identityCookie: { domain: ".github.com", name: "dotcom_user" },
  },
  microsoft: {
    label: "Microsoft",
    groups: new Set(["microsoftonline.com", "live.com", "microsoft.com"]),
    sessionCookie: { domain: ".login.microsoftonline.com", name: "ESTSAUTHPERSISTENT" },
  },
  apple: {
    label: "Apple",
    groups: new Set(["apple.com", "icloud.com"]),
    sessionCookie: { domain: ".apple.com", name: "myacinfo" },
  },
};

const PROVIDER_IDS = Object.keys(ACCOUNT_PROVIDERS) as ReadonlyArray<PreviewAccountProvider>;

export function providerForCookieDomain(domain: string): PreviewAccountProvider | null {
  const group = cookieSiteGroup(domain);
  return PROVIDER_IDS.find((id) => ACCOUNT_PROVIDERS[id].groups.has(group)) ?? null;
}

function isProviderSessionCookie(provider: PreviewAccountProvider, cookie: Cookie): boolean {
  const { domain, name } = ACCOUNT_PROVIDERS[provider].sessionCookie;
  return cookie.name === name && (cookie.domain ?? "") === domain;
}

function cookieUrl(cookie: Cookie): string {
  const host = (cookie.domain ?? "").replace(/^\./, "");
  return `${cookie.secure ? "https" : "http"}://${host}${cookie.path ?? "/"}`;
}

/** The arguments that recreate a stored cookie through Chromium's own API. */
export function cookieSetDetails(cookie: Cookie): CookiesSetDetails {
  return {
    url: cookieUrl(cookie),
    name: cookie.name,
    value: cookie.value,
    path: cookie.path ?? "/",
    secure: cookie.secure ?? false,
    httpOnly: cookie.httpOnly ?? false,
    ...(cookie.hostOnly ? {} : { domain: cookie.domain ?? "" }),
    ...(cookie.expirationDate === undefined ? {} : { expirationDate: cookie.expirationDate }),
    ...(cookie.sameSite === undefined ? {} : { sameSite: cookie.sameSite }),
  };
}

const MAX_MEMORY_EVENTS = 200;
const MAX_LOG_BYTES = 256 * 1024;

export interface BrowserAccountTrackerOptions {
  readonly logPath: string;
  readonly ownerOf: (directory: string) => PreviewAccountOwner | null;
  readonly linksOf: () => ReadonlyArray<BrowserAccountLink>;
  readonly addLink: (link: BrowserAccountLink) => void;
  readonly removeLink: (provider: PreviewAccountProvider, directory: string) => void;
  readonly openSession: (directory: string) => Promise<Session | null>;
  readonly onEvent: (event: PreviewAccountEvent) => void;
  readonly onFailure: (operation: string, cause: unknown) => void;
}

interface KnownAccount {
  readonly identity: string | null;
  readonly live: boolean;
}

export interface BrowserAccountTracker {
  readonly attach: (directory: string, session: Session) => void;
  readonly refresh: (directory: string) => Promise<void>;
  readonly refreshAll: () => Promise<void>;
  readonly sessions: () => ReadonlyArray<PreviewAccountSession>;
  readonly recentEvents: () => ReadonlyArray<PreviewAccountEvent>;
  readonly hasLiveAccount: (directory: string, provider: PreviewAccountProvider) => boolean;
  readonly findLiveElsewhere: (
    directory: string,
    provider: PreviewAccountProvider,
  ) => PreviewAccountSession | null;
  readonly signOut: (provider: PreviewAccountProvider, directory: string) => Promise<void>;
  readonly link: (
    provider: PreviewAccountProvider,
    fromDirectory: string,
    toDirectory: string,
  ) => Promise<void>;
}

export function makeBrowserAccountTracker(
  options: BrowserAccountTrackerOptions,
): BrowserAccountTracker {
  const sessions = new Map<string, Session>();
  /** Directory -> provider -> accounts. */
  const accounts = new Map<string, Map<PreviewAccountProvider, ReadonlyArray<KnownAccount>>>();
  const events: Array<PreviewAccountEvent> = readRecentEvents(options.logPath);
  /** Changes this tracker made itself, so a linked write is not echoed back. */
  const ownWrites = new Set<string>();
  const refreshTimers = new Map<string, ReturnType<typeof setTimeout>>();

  const record = (event: Omit<PreviewAccountEvent, "at" | "owner">) => {
    const complete: PreviewAccountEvent = {
      ...event,
      at: new Date().toISOString(),
      owner: options.ownerOf(event.directory),
    };
    events.unshift(complete);
    events.length = Math.min(events.length, MAX_MEMORY_EVENTS);
    appendEvent(options.logPath, complete, options.onFailure);
    options.onEvent(complete);
  };

  const accountsIn = (directory: string, provider: PreviewAccountProvider) =>
    accounts.get(directory)?.get(provider) ?? [];

  const setAccounts = (
    directory: string,
    provider: PreviewAccountProvider,
    next: ReadonlyArray<KnownAccount>,
  ) => {
    const byProvider =
      accounts.get(directory) ?? new Map<PreviewAccountProvider, ReadonlyArray<KnownAccount>>();
    const previous = byProvider.get(provider) ?? [];
    byProvider.set(provider, next);
    accounts.set(directory, byProvider);
    for (const account of previous) {
      if (!account.live) continue;
      const now = next.find((candidate) => candidate.identity === account.identity);
      if (now === undefined || !now.live) {
        record({ provider, reason: "session-ended", identity: account.identity, directory });
      }
    }
    for (const account of next) {
      if (!account.live) continue;
      const before = previous.find((candidate) => candidate.identity === account.identity);
      if (previous.length > 0 && (before === undefined || !before.live)) {
        record({ provider, reason: "signed-in", identity: account.identity, directory });
      }
    }
  };

  const readProvider = async (
    directory: string,
    session: Session,
    provider: PreviewAccountProvider,
  ): Promise<void> => {
    const definition = ACCOUNT_PROVIDERS[provider];
    const present = await session.cookies.get(definition.sessionCookie);
    if (present.length === 0) {
      setAccounts(directory, provider, []);
      return;
    }
    if (provider === "google") {
      const response = await session.fetch(GOOGLE_ACCOUNT_LIST_URL, {
        method: "POST",
        credentials: "include",
        headers: { Origin: "https://accounts.google.com" },
      });
      // A failed check says nothing about the session, so what is known stands.
      if (!response.ok) return;
      setAccounts(
        directory,
        provider,
        parseGoogleAccountList(await response.text()).map((account) => ({
          identity: account.email,
          live: account.live,
        })),
      );
      return;
    }
    const identityCookie = definition.identityCookie
      ? await session.cookies.get(definition.identityCookie)
      : [];
    setAccounts(directory, provider, [{ identity: identityCookie[0]?.value ?? null, live: true }]);
  };

  const refresh = async (directory: string): Promise<void> => {
    const session = sessions.get(directory) ?? (await options.openSession(directory));
    if (!session) return;
    for (const provider of PROVIDER_IDS) {
      try {
        await readProvider(directory, session, provider);
      } catch (cause) {
        options.onFailure(`refresh ${provider}`, cause);
      }
    }
  };

  const scheduleRefresh = (directory: string) => {
    const pending = refreshTimers.get(directory);
    if (pending) clearTimeout(pending);
    refreshTimers.set(
      directory,
      setTimeout(() => {
        refreshTimers.delete(directory);
        void refresh(directory);
      }, 2_000),
    );
  };

  const writeKey = (directory: string, cookie: Cookie, removed: boolean) =>
    `${directory}\u0000${cookie.domain}\u0000${cookie.path}\u0000${cookie.name}\u0000${removed ? "" : cookie.value}`;

  const applyToLinkedProfiles = (
    directory: string,
    provider: PreviewAccountProvider,
    cookie: Cookie,
    removed: boolean,
  ) => {
    for (const link of options.linksOf()) {
      if (link.provider !== provider || !link.profiles.includes(directory)) continue;
      const other = link.profiles[0] === directory ? link.profiles[1] : link.profiles[0];
      void (async () => {
        const session = sessions.get(other) ?? (await options.openSession(other));
        if (!session) return;
        ownWrites.add(writeKey(other, cookie, removed));
        if (removed) {
          await session.cookies.remove(cookieUrl(cookie), cookie.name);
        } else {
          await session.cookies.set(cookieSetDetails(cookie));
        }
      })().catch((cause: unknown) => options.onFailure("sync linked account", cause));
    }
  };

  const attach = (directory: string, session: Session) => {
    if (sessions.has(directory)) return;
    sessions.set(directory, session);
    session.cookies.on("changed", (_event, cookie, cause, removed) => {
      const provider = providerForCookieDomain(cookie.domain ?? "");
      if (provider === null) return;
      // A rotation removes the old value and writes the new one. Only the write
      // is worth carrying over, and it is not a sign-out.
      if (removed && cause === "overwrite") return;
      const key = writeKey(directory, cookie, removed);
      const echoed = ownWrites.delete(key);
      if (!echoed) {
        // An expiry is each profile's own business: the other may have renewed.
        if (!removed || cause === "explicit") {
          applyToLinkedProfiles(directory, provider, cookie, removed);
        }
      }
      if (!isProviderSessionCookie(provider, cookie)) return;
      if (removed) {
        record({
          provider,
          reason: "signed-out",
          identity:
            accountsIn(directory, provider).find((account) => account.live)?.identity ?? null,
          directory,
          cookieCause: cause,
        });
      }
      scheduleRefresh(directory);
    });
  };

  return {
    attach,
    refresh,
    refreshAll: async () => {
      for (const directory of sessions.keys()) await refresh(directory);
    },
    sessions: () =>
      [...accounts.entries()].flatMap(([directory, byProvider]) => {
        const owner = options.ownerOf(directory);
        if (owner === null) return [];
        return [...byProvider.entries()].flatMap(([provider, known]) =>
          known.map(
            (account): PreviewAccountSession => ({
              provider,
              identity: account.identity,
              live: account.live,
              directory,
              owner,
              linked: options
                .linksOf()
                .some((link) => link.provider === provider && link.profiles.includes(directory)),
            }),
          ),
        );
      }),
    recentEvents: () => [...events],
    hasLiveAccount: (directory, provider) =>
      accountsIn(directory, provider).some((account) => account.live),
    findLiveElsewhere: (directory, provider) => {
      for (const [candidate, byProvider] of accounts) {
        if (candidate === directory) continue;
        const owner = options.ownerOf(candidate);
        // A project's sign-in is offered around; an agent's is its own.
        if (owner?.kind !== "project") continue;
        const live = byProvider.get(provider)?.find((account) => account.live);
        if (live) {
          return {
            provider,
            identity: live.identity,
            live: true,
            directory: candidate,
            owner,
            linked: false,
          };
        }
      }
      return null;
    },
    signOut: async (provider, directory) => {
      const session = sessions.get(directory) ?? (await options.openSession(directory));
      if (!session) return;
      options.removeLink(provider, directory);
      const definition = ACCOUNT_PROVIDERS[provider];
      if (definition.signOutUrl) {
        // Ends the session at the site too; clearing cookies alone only forgets it.
        await session
          .fetch(definition.signOutUrl, { credentials: "include" })
          .catch(() => undefined);
      }
      const cookies = await session.cookies.get({});
      for (const cookie of cookies) {
        if (definition.groups.has(cookieSiteGroup(cookie.domain ?? ""))) {
          await session.cookies.remove(cookieUrl(cookie), cookie.name);
        }
      }
      await session.cookies.flushStore();
      await refresh(directory);
    },
    link: async (provider, fromDirectory, toDirectory) => {
      const from = sessions.get(fromDirectory) ?? (await options.openSession(fromDirectory));
      const to = sessions.get(toDirectory) ?? (await options.openSession(toDirectory));
      if (!from || !to) throw new Error("A browser profile for this account is not available.");
      const definition = ACCOUNT_PROVIDERS[provider];
      const cookies = (await from.cookies.get({})).filter((cookie) =>
        definition.groups.has(cookieSiteGroup(cookie.domain ?? "")),
      );
      for (const cookie of cookies) {
        ownWrites.add(writeKey(toDirectory, cookie, false));
        await to.cookies.set(cookieSetDetails(cookie));
      }
      await to.cookies.flushStore();
      options.addLink({ provider, profiles: [fromDirectory, toDirectory] });
      await refresh(toDirectory);
    },
  };
}

function readRecentEvents(logPath: string): Array<PreviewAccountEvent> {
  try {
    return NodeFS.readFileSync(logPath, "utf8")
      .split("\n")
      .filter((line) => line.length > 0)
      .slice(-MAX_MEMORY_EVENTS)
      .map((line) => JSON.parse(line) as PreviewAccountEvent)
      .toReversed();
  } catch {
    return [];
  }
}

function appendEvent(
  logPath: string,
  event: PreviewAccountEvent,
  onFailure: (operation: string, cause: unknown) => void,
): void {
  try {
    NodeFS.mkdirSync(NodePath.dirname(logPath), { recursive: true });
    const size = NodeFS.statSync(logPath, { throwIfNoEntry: false })?.size ?? 0;
    if (size > MAX_LOG_BYTES) {
      const kept = NodeFS.readFileSync(logPath, "utf8").split("\n").slice(-MAX_MEMORY_EVENTS);
      NodeFS.writeFileSync(logPath, kept.join("\n"), { mode: 0o600 });
    }
    NodeFS.appendFileSync(logPath, `${JSON.stringify(event)}\n`, { mode: 0o600 });
  } catch (cause) {
    onFailure("write account log", cause);
  }
}

/**
 * Rewrite a jar's stored cookies through Chromium so they land encrypted.
 *
 * Existing plain-text rows stay readable after encryption is turned on, and only
 * move when a site happens to rewrite them. This must run before any page in the
 * profile loads: writing back a value a page has since rotated would end its
 * session.
 */
export async function rewriteStoredCookies(session: Session): Promise<{
  readonly rewritten: number;
  readonly failed: number;
}> {
  const cookies = await session.cookies.get({});
  let rewritten = 0;
  let failed = 0;
  for (const cookie of cookies) {
    try {
      await session.cookies.set(cookieSetDetails(cookie));
      rewritten += 1;
    } catch {
      // Chromium refuses some it stored itself, such as an already expired one.
      failed += 1;
    }
  }
  await session.cookies.flushStore();
  return { rewritten, failed };
}
