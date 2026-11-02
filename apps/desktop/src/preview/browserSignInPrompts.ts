// @effect-diagnostics nodeBuiltinImport:off - The "never for this site" list is a small local file.
// @effect-diagnostics globalDate:off - Attempts are aged from synchronous guest message handlers.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import type {
  PreviewAccountPrompt,
  PreviewAccountPromptAnswer,
  PreviewAccountProvider,
  PreviewAccountSession,
  PreviewCredentialSummary,
} from "@t3tools/contracts";

import { providerForCookieDomain } from "./browserAccounts.ts";

/** How long a submitted password waits for the sign-in to finish, 2FA included. */
const ATTEMPT_TTL_MS = 5 * 60_000;
const USERNAME_TTL_MS = 10 * 60_000;

const GOOGLE_ACCOUNTS_ORIGIN = "https://accounts.google.com";

/**
 * Google refuses a sign-in it sees under automation, and a saved Google password
 * is the key to everything behind that account, so filling it stays with a person.
 */
export function isPersonOnlySignInOrigin(origin: string): boolean {
  try {
    const { hostname } = new URL(origin);
    return hostname === "accounts.google.com" || hostname.endsWith(".accounts.google.com");
  } catch {
    return false;
  }
}

export const signInPromptNowMs = (): number => Date.now();
export const newSignInPromptId = (): string => NodeCrypto.randomUUID();

/** The same site, whichever host a sign-in moved through. */
function sameSignInSite(left: string, right: string): boolean {
  try {
    const leftHost = new URL(left).hostname.split(".").slice(-2).join(".");
    const rightHost = new URL(right).hostname.split(".").slice(-2).join(".");
    return leftHost === rightHost;
  } catch {
    return false;
  }
}

export interface SignInPromptDependencies {
  readonly listCredentials: () => Promise<ReadonlyArray<PreviewCredentialSummary>>;
  readonly listCredentialsForOrigin: (
    origin: string,
  ) => Promise<ReadonlyArray<PreviewCredentialSummary>>;
  /** The stored secret, to tell "already saved" from "changed". */
  readonly readSecret: (id: string, origin: string) => Promise<string | null>;
  readonly saveCredential: (input: {
    readonly id?: string;
    readonly label: string;
    readonly origin: string;
    readonly username: string;
    readonly secret: string;
  }) => Promise<unknown>;
  readonly setPrompts: (tabId: string, prompts: ReadonlyArray<PreviewAccountPrompt>) => void;
  readonly fillForPerson: (tabId: string, secret: string) => Promise<void>;
  readonly profileKindOf: (directory: string) => "project" | "agent" | null;
  readonly findLiveElsewhere: (
    directory: string,
    provider: PreviewAccountProvider,
  ) => PreviewAccountSession | null;
  readonly linkAccount: (
    provider: PreviewAccountProvider,
    fromDirectory: string,
    toDirectory: string,
  ) => Promise<void>;
  readonly newestLiveIdentity: (
    directory: string,
    provider: PreviewAccountProvider,
  ) => string | null;
  readonly neverListPath: string;
  readonly newId: () => string;
  readonly nowMs: () => number;
  readonly onFailure: (operation: string, cause: unknown) => void;
}

interface Attempt {
  readonly tabId: string;
  readonly directory: string;
  readonly origin: string;
  readonly username: string;
  readonly password: string;
  readonly atMs: number;
}

type PromptAction =
  | { readonly kind: "remember"; readonly attempt: Attempt; readonly existingId: string | null }
  | {
      readonly kind: "use-account";
      readonly provider: PreviewAccountProvider;
      readonly fromDirectory: string;
      readonly toDirectory: string;
    }
  | { readonly kind: "fill-saved"; readonly credentialId: string; readonly origin: string };

/**
 * The sign-in questions shown on a browser tab: remember this password, use an
 * account already signed in elsewhere, fill a saved password.
 *
 * A captured password lives only in this object, for only as long as its
 * question stands. It is encrypted into the vault if the answer is yes and
 * dropped otherwise, and it never reaches the renderer or a log.
 */
export class BrowserSignInPrompts {
  private readonly attempts = new Map<number, Attempt>();
  private readonly usernames = new Map<
    number,
    { readonly origin: string; readonly username: string; readonly atMs: number }
  >();
  private readonly promptsByTab = new Map<string, ReadonlyArray<PreviewAccountPrompt>>();
  private readonly actions = new Map<string, { tabId: string; action: PromptAction }>();
  private neverSites: Set<string> | null = null;

  private readonly dependencies: SignInPromptDependencies;

  constructor(dependencies: SignInPromptDependencies) {
    this.dependencies = dependencies;
  }

  noteUsername(webContentsId: number, origin: string, username: string): void {
    this.usernames.set(webContentsId, { origin, username, atMs: this.dependencies.nowMs() });
  }

  /** A person submitted a password. An agent's own typing never gets here. */
  noteAttempt(input: {
    readonly webContentsId: number;
    readonly tabId: string;
    readonly directory: string;
    readonly origin: string;
    readonly username: string;
    readonly password: string;
  }): void {
    if (this.isNeverSite(input.origin)) return;
    const remembered = this.usernames.get(input.webContentsId);
    const username =
      input.username ||
      (remembered &&
      sameSignInSite(remembered.origin, input.origin) &&
      this.dependencies.nowMs() - remembered.atMs < USERNAME_TTL_MS
        ? remembered.username
        : "");
    this.attempts.set(input.webContentsId, {
      tabId: input.tabId,
      directory: input.directory,
      origin: input.origin,
      username,
      password: input.password,
      atMs: this.dependencies.nowMs(),
    });
  }

  /** The page settled. No password box any more means the sign-in went through. */
  async notePage(input: {
    readonly webContentsId: number;
    readonly tabId: string;
    readonly directory: string;
    readonly origin: string;
    readonly hasPasswordField: boolean;
  }): Promise<void> {
    const attempt = this.attempts.get(input.webContentsId);
    if (attempt && this.dependencies.nowMs() - attempt.atMs > ATTEMPT_TTL_MS) {
      this.attempts.delete(input.webContentsId);
    } else if (attempt && !input.hasPasswordField) {
      // Google's 2FA pages have no password box either, so it has to have left
      // the sign-in host before that counts as done.
      if (attempt.origin === GOOGLE_ACCOUNTS_ORIGIN && input.origin === GOOGLE_ACCOUNTS_ORIGIN) {
        return;
      }
      this.attempts.delete(input.webContentsId);
      await this.offerRemember(attempt);
      return;
    }
    if (attempt) return;
    await this.offerAccountOrSavedLogin(input);
  }

  async answer(id: string, answer: PreviewAccountPromptAnswer): Promise<void> {
    const held = this.actions.get(id);
    if (!held) return;
    this.actions.delete(id);
    this.dropPrompt(held.tabId, id);
    const { action } = held;
    if (answer === "never-for-site" && action.kind === "remember") {
      this.addNeverSite(action.attempt.origin);
      return;
    }
    if (answer !== "accept") return;
    if (action.kind === "remember") {
      await this.dependencies.saveCredential({
        ...(action.existingId === null ? {} : { id: action.existingId }),
        label: labelForOrigin(action.attempt.origin),
        origin: action.attempt.origin,
        username: action.attempt.username,
        secret: action.attempt.password,
      });
      return;
    }
    if (action.kind === "use-account") {
      await this.dependencies.linkAccount(
        action.provider,
        action.fromDirectory,
        action.toDirectory,
      );
      return;
    }
    const secret = await this.dependencies.readSecret(action.credentialId, action.origin);
    if (secret !== null) await this.dependencies.fillForPerson(held.tabId, secret);
  }

  forgetGuest(webContentsId: number): void {
    this.attempts.delete(webContentsId);
    this.usernames.delete(webContentsId);
  }

  forgetTab(tabId: string): void {
    this.promptsByTab.delete(tabId);
    for (const [id, held] of this.actions) {
      if (held.tabId === tabId) this.actions.delete(id);
    }
    for (const [webContentsId, attempt] of this.attempts) {
      if (attempt.tabId === tabId) this.attempts.delete(webContentsId);
    }
  }

  private async offerRemember(attempt: Attempt): Promise<void> {
    const { dependencies } = this;
    const provider = providerForOrigin(attempt.origin);
    const username =
      attempt.username ||
      (provider === null ? null : dependencies.newestLiveIdentity(attempt.directory, provider)) ||
      "";
    // Without a name there is nothing to tell this login from another by.
    if (username.length === 0) return;
    const existing = (await dependencies.listCredentials()).find(
      (credential) =>
        credential.origin === attempt.origin &&
        (credential.username ?? "").toLowerCase() === username.toLowerCase(),
    );
    if (existing) {
      const stored = await dependencies.readSecret(existing.id, attempt.origin);
      if (stored === attempt.password) return;
    }
    this.addPrompt(
      attempt.tabId,
      {
        id: "",
        kind: "remember",
        origin: attempt.origin,
        username,
        update: existing !== undefined,
      },
      {
        kind: "remember",
        attempt: { ...attempt, username },
        existingId: existing?.id ?? null,
      },
    );
  }

  private async offerAccountOrSavedLogin(input: {
    readonly tabId: string;
    readonly directory: string;
    readonly origin: string;
    readonly hasPasswordField: boolean;
  }): Promise<void> {
    const { dependencies } = this;
    const provider = providerForOrigin(input.origin);
    const onProviderSignIn = provider !== null && isProviderSignInOrigin(input.origin);
    // An agent starts signed out and is given accounts from Settings, so a page
    // it happens to open does not offer it the person's.
    if (onProviderSignIn && dependencies.profileKindOf(input.directory) === "project") {
      const elsewhere = dependencies.findLiveElsewhere(input.directory, provider);
      if (elsewhere && !this.hasPrompt(input.tabId, "use-account")) {
        this.addPrompt(
          input.tabId,
          {
            id: "",
            kind: "use-account",
            provider,
            identity: elsewhere.identity,
            fromDirectory: elsewhere.directory,
            fromOwner: elsewhere.owner,
          },
          {
            kind: "use-account",
            provider,
            fromDirectory: elsewhere.directory,
            toDirectory: input.directory,
          },
        );
        return;
      }
    }
    if (!input.hasPasswordField || this.hasPrompt(input.tabId, "fill-saved")) return;
    const saved = (await dependencies.listCredentialsForOrigin(input.origin)).find(
      (credential) => (credential.kind ?? "password") === "password",
    );
    if (!saved) return;
    this.addPrompt(
      input.tabId,
      {
        id: "",
        kind: "fill-saved",
        credentialId: saved.id,
        origin: input.origin,
        username: saved.username ?? "",
      },
      { kind: "fill-saved", credentialId: saved.id, origin: input.origin },
    );
  }

  private hasPrompt(tabId: string, kind: PreviewAccountPrompt["kind"]): boolean {
    return (this.promptsByTab.get(tabId) ?? []).some((prompt) => prompt.kind === kind);
  }

  private addPrompt(tabId: string, prompt: PreviewAccountPrompt, action: PromptAction): void {
    const id = this.dependencies.newId();
    this.actions.set(id, { tabId, action });
    const next = [
      // A newer question of the same kind replaces the last: one bar at a time.
      ...(this.promptsByTab.get(tabId) ?? []).filter((existing) => {
        if (existing.kind !== prompt.kind) return true;
        this.actions.delete(existing.id);
        return false;
      }),
      { ...prompt, id },
    ];
    this.promptsByTab.set(tabId, next);
    this.dependencies.setPrompts(tabId, next);
  }

  private dropPrompt(tabId: string, id: string): void {
    const next = (this.promptsByTab.get(tabId) ?? []).filter((prompt) => prompt.id !== id);
    this.promptsByTab.set(tabId, next);
    this.dependencies.setPrompts(tabId, next);
  }

  private loadNeverSites(): Set<string> {
    if (this.neverSites) return this.neverSites;
    try {
      const parsed = JSON.parse(
        NodeFS.readFileSync(this.dependencies.neverListPath, "utf8"),
      ) as unknown;
      this.neverSites = new Set(
        Array.isArray(parsed)
          ? parsed.filter((entry): entry is string => typeof entry === "string")
          : [],
      );
    } catch {
      this.neverSites = new Set();
    }
    return this.neverSites;
  }

  private isNeverSite(origin: string): boolean {
    return this.loadNeverSites().has(origin);
  }

  private addNeverSite(origin: string): void {
    const sites = this.loadNeverSites();
    sites.add(origin);
    try {
      NodeFS.writeFileSync(this.dependencies.neverListPath, JSON.stringify([...sites]), {
        mode: 0o600,
      });
    } catch (cause) {
      this.dependencies.onFailure("save never-remember list", cause);
    }
  }
}

function providerForOrigin(origin: string): PreviewAccountProvider | null {
  try {
    return providerForCookieDomain(new URL(origin).hostname);
  } catch {
    return null;
  }
}

/** Where each provider asks for a sign-in, as opposed to its ordinary pages. */
function isProviderSignInOrigin(origin: string): boolean {
  try {
    const { hostname } = new URL(origin);
    return (
      hostname === "accounts.google.com" ||
      hostname === "github.com" ||
      hostname === "login.microsoftonline.com" ||
      hostname === "login.live.com" ||
      hostname === "appleid.apple.com"
    );
  } catch {
    return false;
  }
}

function labelForOrigin(origin: string): string {
  try {
    return new URL(origin).hostname.replace(/^(www|accounts|login)\./, "");
  } catch {
    return origin;
  }
}
