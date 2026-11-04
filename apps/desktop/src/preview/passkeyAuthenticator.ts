/**
 * The virtual authenticator that lets a preview guest use passkeys Solla holds.
 *
 * Chromium keeps it per document, so it has to be installed again after every
 * main-frame navigation commit: before the commit an add fails because the old
 * document's is still there, and after it the old one is gone with its keys.
 */

export type PasskeyCdpSend = (method: string, params?: Record<string, unknown>) => Promise<unknown>;

/** A credential as `WebAuthn.addCredential` takes it and `credentialAdded` reports it. */
export interface PasskeyCdpCredential {
  readonly credentialId: string;
  readonly isResidentCredential: boolean;
  readonly rpId?: string;
  readonly privateKey: string;
  readonly userHandle?: string;
  readonly signCount: number;
  readonly backupEligibility?: boolean;
  readonly backupState?: boolean;
  readonly userName?: string;
  readonly userDisplayName?: string;
}

const AUTHENTICATOR_OPTIONS = {
  protocol: "ctap2",
  ctap2Version: "ctap2_1",
  transport: "internal",
  hasResidentKey: true,
  hasUserVerification: true,
  isUserVerified: true,
  // Solla has no prompt of its own: turning a site on is the person's consent.
  automaticPresenceSimulation: true,
} as const;

export async function installPasskeyAuthenticator(
  send: PasskeyCdpSend,
  credentials: ReadonlyArray<PasskeyCdpCredential>,
): Promise<void> {
  await send("WebAuthn.disable").catch(() => undefined);
  await send("WebAuthn.enable", { enableUI: false });
  const added = (await send("WebAuthn.addVirtualAuthenticator", {
    options: AUTHENTICATOR_OPTIONS,
  })) as { readonly authenticatorId: string };
  for (const credential of credentials) {
    await send("WebAuthn.addCredential", { authenticatorId: added.authenticatorId, credential });
  }
}

/** The credential on a `WebAuthn.credential*` event, if it is complete enough to keep. */
export function passkeyCredentialFromEvent(
  params: Readonly<Record<string, unknown>>,
): PasskeyCdpCredential | null {
  const credential = params["credential"];
  if (typeof credential !== "object" || credential === null) return null;
  const value = credential as Record<string, unknown>;
  if (
    typeof value["credentialId"] !== "string" ||
    typeof value["privateKey"] !== "string" ||
    typeof value["signCount"] !== "number"
  ) {
    return null;
  }
  return value as unknown as PasskeyCdpCredential;
}

/**
 * The account to answer with when a site lets the browser choose: the newest.
 * Chromium signs with every candidate before asking, so which one was really
 * used can't be told afterwards. To sign in as another, remove the newer one.
 */
export function pickPasskeyAccount(
  accounts: ReadonlyArray<{ readonly credentialId: string }>,
  createdAt: (credentialId: string) => string | undefined,
): string | null {
  let chosen: { readonly id: string; readonly at: string } | null = null;
  for (const { credentialId } of accounts) {
    const at = createdAt(credentialId) ?? "";
    if (chosen === null || at > chosen.at) chosen = { id: credentialId, at };
  }
  return chosen?.id ?? null;
}

/** DevTools reports credential ids in base64 and the account picker in base64url. */
export const passkeyIdKey = (credentialId: string): string =>
  credentialId.replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
