import type { UserInputQuestion } from "@t3tools/contracts";

/**
 * An agent's request that the person sign in for it.
 *
 * Carried on a durable `user-input.requested` activity. The secret itself goes
 * from the card straight to the desktop's encrypted vault, and the answer the
 * agent gets back holds only the opaque id of that entry, so a password never
 * enters a thread, a log, or a model's context.
 */
export const CREDENTIAL_REQUEST_QUESTION_ID = "t3_credential_request";
export const CREDENTIAL_REQUEST_ID_PREFIX = "credential-request:";
/** Answer key beside the question's own: the vault entry the person just added. */
export const CREDENTIAL_REQUEST_CREDENTIAL_ID_KEY = "t3_credential_id";

export const CREDENTIAL_DECLINE_CHOICE = "Not now";
export const CREDENTIAL_SIGNED_IN_CHOICE = "I've signed in";
export const CREDENTIAL_PASSKEYS_ON_ANSWER = "Turned on passkeys";
export const CREDENTIAL_SAVED_ANSWER = "Entered and saved";
export const CREDENTIAL_USED_ONCE_ANSWER = "Entered for this sign-in";

/**
 * `password` and `code` collect a secret on the card. `person` asks the person
 * to finish on the page themselves: for sites that refuse automation, for
 * single sign-on, and for two-step approvals that have nothing to type.
 * `passkey` asks to turn on passkeys Solla holds for the site.
 */
export type CredentialRequestMode = "password" | "code" | "person" | "passkey";

export interface CredentialRequest {
  /** Read from the tab by the server, never supplied by the agent. */
  readonly origin: string;
  readonly mode: CredentialRequestMode;
  /** The agent's own words for why it is asking. */
  readonly reason: string;
  readonly usernameHint?: string;
}

export type CredentialRequestAnswer =
  | { readonly status: "provided"; readonly credentialId: string; readonly saved: boolean }
  | { readonly status: "signed_in" }
  | { readonly status: "passkeys_on" }
  | { readonly status: "declined" }
  | { readonly status: "feedback"; readonly feedback: string };

export function isCredentialRequestId(requestId: string): boolean {
  return requestId.startsWith(CREDENTIAL_REQUEST_ID_PREFIX);
}

export function isCredentialRequestQuestion(
  question: Pick<UserInputQuestion, "id"> | null | undefined,
): boolean {
  return question?.id === CREDENTIAL_REQUEST_QUESTION_ID;
}

/**
 * Google refuses a sign-in it sees under automation, and a saved Google password
 * is the key to everything behind that account, so signing in stays with a person.
 */
export function isPersonOnlySignInOrigin(origin: string): boolean {
  try {
    const { hostname } = new URL(origin);
    return hostname === "accounts.google.com" || hostname.endsWith(".accounts.google.com");
  } catch {
    return false;
  }
}

/** The site's name as the person knows it: the host without its scheme. */
export function credentialRequestSiteName(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
}

export function credentialRequestFingerprint(input: {
  readonly origin: string;
  readonly mode: CredentialRequestMode;
}): string {
  return `credential\n${input.origin}\n${input.mode}`;
}

/** The request on a `user-input.requested` payload, or null if it is not one. */
export function parseCredentialRequest(payload: unknown): CredentialRequest | null {
  if (typeof payload !== "object" || payload === null) return null;
  const request = (payload as Record<string, unknown>).credentialRequest;
  if (typeof request !== "object" || request === null) return null;
  const { origin, mode, reason, usernameHint } = request as Record<string, unknown>;
  if (typeof origin !== "string" || typeof reason !== "string") return null;
  if (mode !== "password" && mode !== "code" && mode !== "person" && mode !== "passkey") {
    return null;
  }
  return {
    origin,
    mode,
    reason,
    ...(typeof usernameHint === "string" && usernameHint.length > 0 ? { usernameHint } : {}),
  };
}

/** The non-secret answer a card sends once the vault holds what was entered. */
export function credentialProvidedAnswers(input: {
  readonly credentialId: string;
  readonly saved: boolean;
}): Record<string, string> {
  return {
    [CREDENTIAL_REQUEST_QUESTION_ID]: input.saved
      ? CREDENTIAL_SAVED_ANSWER
      : CREDENTIAL_USED_ONCE_ANSWER,
    [CREDENTIAL_REQUEST_CREDENTIAL_ID_KEY]: input.credentialId,
  };
}

export function credentialRequestAnswerFromUnknown(
  answers: Readonly<Record<string, unknown>>,
): CredentialRequestAnswer {
  const raw = answers[CREDENTIAL_REQUEST_QUESTION_ID];
  const answer = typeof raw === "string" ? raw.trim() : "";
  const credentialId = answers[CREDENTIAL_REQUEST_CREDENTIAL_ID_KEY];
  if (typeof credentialId === "string" && credentialId.length > 0) {
    return { status: "provided", credentialId, saved: answer === CREDENTIAL_SAVED_ANSWER };
  }
  if (answer.length === 0 || answer === CREDENTIAL_DECLINE_CHOICE) return { status: "declined" };
  if (answer === CREDENTIAL_SIGNED_IN_CHOICE) return { status: "signed_in" };
  if (answer === CREDENTIAL_PASSKEYS_ON_ANSWER) return { status: "passkeys_on" };
  return { status: "feedback", feedback: answer };
}
