import type {
  PreviewCredentialId,
  PreviewCredentialKind,
  PreviewCredentialSummary,
  PreviewPasskeysSnapshot,
  PreviewPasskeySummary,
} from "@t3tools/contracts";
import { passkeySiteForHost } from "@t3tools/shared/passkeySites";

/** What the credential editor is doing: adding a new entry or editing a saved one. */
export type CredentialEditorMode =
  | { readonly kind: "add"; readonly origin?: string }
  | { readonly kind: "edit"; readonly credential: PreviewCredentialSummary };

export interface CredentialDraft {
  readonly kind: PreviewCredentialKind;
  readonly label: string;
  readonly origin: string;
  readonly username: string;
  readonly secret: string;
}

export interface CredentialSaveInput {
  readonly id?: PreviewCredentialId;
  readonly label: string;
  readonly origin: string;
  readonly kind: PreviewCredentialKind;
  readonly username?: string;
  readonly secret?: string;
  readonly ephemeral?: boolean;
}

/**
 * The two kinds of saved secret, as the editors offer them. A password fills
 * only password boxes. A PIN or code also fills plain text and number boxes,
 * which is where many sites ask for one, so it can show on the page.
 */
export const CREDENTIAL_KINDS: readonly {
  readonly kind: PreviewCredentialKind;
  readonly label: string;
  readonly description: string;
}[] = [
  { kind: "password", label: "Password", description: "Fills only password boxes." },
  {
    kind: "code",
    label: "PIN or code",
    description:
      "Also fills plain text and number boxes, where sites often ask for a PIN. It can show on the page once filled.",
  },
];

/** Entries saved before PINs and codes existed carry no kind: they are passwords. */
export function credentialKindOf(credential: PreviewCredentialSummary): PreviewCredentialKind {
  return credential.kind ?? "password";
}

/** What the secret is called mid-sentence: "Save the password", "Show PIN or code". */
export function credentialSecretName(kind: PreviewCredentialKind): string {
  return kind === "code" ? "PIN or code" : "password";
}

export function initialCredentialDraft(mode: CredentialEditorMode): CredentialDraft {
  if (mode.kind === "edit") {
    return {
      kind: credentialKindOf(mode.credential),
      label: mode.credential.label,
      origin: mode.credential.origin,
      username: mode.credential.username ?? "",
      secret: "",
    };
  }
  return { kind: "password", label: "", origin: mode.origin ?? "", username: "", secret: "" };
}

/**
 * The site a draft will fill, as the desktop vault will store it.
 *
 * A bare host like `github.com` is read as HTTPS, since that is what people
 * type. The vault stays the authority: it re-normalizes and rejects plain HTTP
 * outside localhost, and its reason is shown if it does.
 */
export function credentialOriginFromInput(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const url = new URL(candidate);
    return url.protocol === "https:" || url.protocol === "http:" ? url.origin : null;
  } catch {
    return null;
  }
}

/**
 * The bridge payload for a draft, or null while it is incomplete.
 *
 * Editing with the password left blank omits `secret`, which keeps the saved
 * password: the renderer never learns it, so it can never send it back. A PIN
 * or code has no username, so switching an entry to one drops it.
 */
export function credentialSaveInput(
  mode: CredentialEditorMode,
  draft: CredentialDraft,
): CredentialSaveInput | null {
  const label = draft.label.trim();
  const origin = credentialOriginFromInput(draft.origin);
  const username = draft.kind === "code" ? "" : draft.username.trim();
  if (!label || label.length > 128 || !origin) return null;
  if (mode.kind === "add" && !draft.secret) return null;
  return {
    ...(mode.kind === "edit" ? { id: mode.credential.id } : {}),
    label,
    origin,
    kind: draft.kind,
    ...(username ? { username } : {}),
    ...(draft.secret ? { secret: draft.secret } : {}),
  };
}

/** Saved entries grouped by site, then by label, so one site's logins sit together. */
export function sortCredentials(
  credentials: readonly PreviewCredentialSummary[],
): PreviewCredentialSummary[] {
  // .sort() on a copy, not .toSorted(): Hermes doesn't ship the ES2023
  // change-by-copy array methods, and the phone uses this too.
  return [...credentials].sort(
    (left, right) =>
      left.origin.localeCompare(right.origin) || left.label.localeCompare(right.label),
  );
}

/** Replaces the entry with the same id, or appends a new one. */
export function upsertCredential(
  credentials: readonly PreviewCredentialSummary[],
  saved: PreviewCredentialSummary,
): PreviewCredentialSummary[] {
  return [...credentials.filter((credential) => credential.id !== saved.id), saved];
}

export function credentialErrorMessage(cause: unknown, fallback: string): string {
  if (cause instanceof Error && cause.message) {
    // Electron prefixes rejected IPC calls with the channel name.
    return cause.message.replace(/^Error invoking remote method '[^']+': (?:\w+: )?/, "");
  }
  return fallback;
}

/**
 * What a credential request card hands the vault, or null while it is
 * incomplete. Filing it under the tab's own origin is what adds the domain, so
 * the person never types one. The agent's filling a password box depends on the
 * username too, but some sites ask for a password alone, so it stays optional.
 */
export function credentialRequestSaveInput(input: {
  readonly origin: string;
  readonly kind: PreviewCredentialKind;
  readonly username: string;
  readonly secret: string;
  readonly save: boolean;
}): CredentialSaveInput | null {
  if (!input.secret) return null;
  const username = input.kind === "code" ? "" : input.username.trim();
  let label: string;
  try {
    label = new URL(input.origin).host;
  } catch {
    return null;
  }
  return {
    label,
    origin: input.origin,
    kind: input.kind,
    ...(username ? { username } : {}),
    secret: input.secret,
    ...(input.save ? {} : { ephemeral: true }),
  };
}

export interface PasskeySiteRow {
  readonly site: string;
  readonly enabled: boolean;
  readonly passkeys: readonly PreviewPasskeySummary[];
}

/**
 * The settings list: every site that is on or still holds a passkey. A site
 * turned off keeps its passkeys, so turning it back on doesn't lose the account.
 */
export function passkeySiteRows(snapshot: PreviewPasskeysSnapshot): readonly PasskeySiteRow[] {
  const passkeysBySite = new Map<string, PreviewPasskeySummary[]>();
  for (const passkey of snapshot.passkeys) {
    const site = passkeySiteForHost(passkey.rpId);
    passkeysBySite.set(site, [...(passkeysBySite.get(site) ?? []), passkey]);
  }
  return [...new Set([...snapshot.sites, ...passkeysBySite.keys()])]
    .toSorted((left, right) => left.localeCompare(right))
    .map((site) => ({
      site,
      enabled: snapshot.sites.includes(site),
      passkeys: passkeysBySite.get(site) ?? [],
    }));
}

/** What a passkey is called in a list: the account name, or a stand-in when a site gave none. */
export function passkeyAccountName(passkey: PreviewPasskeySummary): string {
  return passkey.userName || passkey.userDisplayName || "Unnamed account";
}
