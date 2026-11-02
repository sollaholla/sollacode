import type {
  PreviewAccountEvent,
  PreviewAccountOwner,
  PreviewAccountProvider,
  PreviewAccountSession,
} from "@t3tools/contracts";

export const ACCOUNT_PROVIDER_LABELS: Readonly<Record<PreviewAccountProvider, string>> = {
  google: "Google",
  github: "GitHub",
  microsoft: "Microsoft",
  apple: "Apple",
};

/** One account, wherever it is signed in. */
export interface AccountSummary {
  readonly key: string;
  readonly provider: PreviewAccountProvider;
  readonly identity: string | null;
  /** Signed in on at least one profile. */
  readonly live: boolean;
  readonly profiles: ReadonlyArray<PreviewAccountSession>;
}

/**
 * Group sessions into accounts: live ones first, then by name. An account a
 * profile merely remembers as signed out, with no live session anywhere and no
 * way to act on it, stays listed so "Sign in again" has somewhere to be.
 */
export function summarizeAccounts(
  sessions: ReadonlyArray<PreviewAccountSession>,
): ReadonlyArray<AccountSummary> {
  const accounts = new Map<string, Array<PreviewAccountSession>>();
  for (const session of sessions) {
    const key = `${session.provider}\u0000${session.identity ?? ""}`;
    const profiles = accounts.get(key) ?? [];
    profiles.push(session);
    accounts.set(key, profiles);
  }
  return [...accounts.entries()]
    .map(([key, profiles]) => {
      const first = profiles[0] as PreviewAccountSession;
      return {
        key,
        provider: first.provider,
        identity: first.identity,
        live: profiles.some((profile) => profile.live),
        profiles,
      };
    })
    .toSorted(
      (left, right) =>
        Number(right.live) - Number(left.live) ||
        (left.identity ?? "").localeCompare(right.identity ?? "") ||
        left.provider.localeCompare(right.provider),
    );
}

/** Where a person goes to sign in to this account again. */
export function accountSignInUrl(
  provider: PreviewAccountProvider,
  identity: string | null,
): string {
  switch (provider) {
    case "google":
      return identity === null
        ? "https://accounts.google.com/"
        : `https://accounts.google.com/AccountChooser?Email=${encodeURIComponent(identity)}`;
    case "github":
      return "https://github.com/login";
    case "microsoft":
      return "https://login.microsoftonline.com/";
    case "apple":
      return "https://appleid.apple.com/sign-in";
  }
}

/** A person asked for this themselves, so it needs no notice. */
export const ACCOUNT_EVENT_CAUSE_ACCOUNTS_PAGE = "accounts-page";
/** It followed a change in a linked profile, which got its own notice. */
export const ACCOUNT_EVENT_CAUSE_LINKED = "linked";

export function isUnexpectedSignOut(event: PreviewAccountEvent): boolean {
  if (event.reason === "signed-in") return false;
  return (
    event.cookieCause !== ACCOUNT_EVENT_CAUSE_ACCOUNTS_PAGE &&
    event.cookieCause !== ACCOUNT_EVENT_CAUSE_LINKED
  );
}

export function accountDisplayName(input: {
  readonly provider: PreviewAccountProvider;
  readonly identity: string | null;
}): string {
  return input.identity ?? `your ${ACCOUNT_PROVIDER_LABELS[input.provider]} account`;
}

/** One line for the sign-out history, naming the cause when the browser reports one. */
export function accountEventSentence(
  event: PreviewAccountEvent,
  ownerLabel: (owner: PreviewAccountOwner) => string,
): string {
  const provider = ACCOUNT_PROVIDER_LABELS[event.provider];
  const name = accountDisplayName(event);
  const where = event.owner === null ? "" : ` in ${ownerLabel(event.owner)}`;
  switch (event.reason) {
    case "signed-in":
      return `Signed in to ${name}${where}.`;
    case "session-ended":
      return `${provider} ended the session for ${name}${where}.`;
    case "signed-out":
      switch (event.cookieCause) {
        case ACCOUNT_EVENT_CAUSE_ACCOUNTS_PAGE:
          return `You signed out of ${name}${where}.`;
        case ACCOUNT_EVENT_CAUSE_LINKED:
          return `Signed out of ${name}${where}, following a linked project.`;
        case "expired":
        case "expired-overwrite":
          return `${name} expired${where}.`;
        case "evicted":
          return `The browser dropped ${name}${where} to make room.`;
        default:
          return `${provider} signed out ${name}${where}.`;
      }
  }
}
