import {
  PreviewAccountsSnapshot,
  PreviewCredentialSummary,
  PreviewCredentialVaultError,
  type EnvironmentId,
  type PreviewAccountLinkInput,
  type PreviewAccountSignOutInput,
  type PreviewCredentialRemoveInput,
  type PreviewCredentialSaveInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as PreviewAutomationBroker from "../mcp/PreviewAutomationBroker.ts";

type CredentialVaultRelay = Pick<
  PreviewAutomationBroker.PreviewAutomationBroker["Service"],
  "manageCredentials"
>;

const decodeSummaries = Schema.decodeUnknownEffect(Schema.Array(PreviewCredentialSummary));
const decodeSummary = Schema.decodeUnknownEffect(PreviewCredentialSummary);
const decodeAccounts = Schema.decodeUnknownEffect(PreviewAccountsSnapshot);

// The desktop answered with something this server cannot read, most likely a
// different app version. Its value is not echoed: it could be anything.
const unreadableAnswer = () =>
  new PreviewCredentialVaultError({
    reason: "rejected",
    message:
      "The desktop app sent an answer this server could not read. Update both and try again.",
  });

/**
 * Settings → Credentials from any client. Saved passwords stay in the vault of
 * the desktop app on the environment's own machine, which agents' fills read
 * from; these relay a settings screen's change there. A new password crosses
 * inbound once and is never logged, persisted, or returned.
 */
export const listRemoteCredentials = (input: {
  readonly broker: CredentialVaultRelay;
  readonly environmentId: EnvironmentId;
}) =>
  input.broker
    .manageCredentials({ environmentId: input.environmentId, command: { action: "list" } })
    .pipe(
      Effect.flatMap((result) => decodeSummaries(result).pipe(Effect.mapError(unreadableAnswer))),
    );

export const saveRemoteCredential = (input: {
  readonly broker: CredentialVaultRelay;
  readonly environmentId: EnvironmentId;
  readonly credential: PreviewCredentialSaveInput;
}) =>
  input.broker
    .manageCredentials({
      environmentId: input.environmentId,
      command: { action: "save", credential: input.credential },
    })
    .pipe(
      Effect.flatMap((result) => decodeSummary(result).pipe(Effect.mapError(unreadableAnswer))),
    );

export const removeRemoteCredential = (input: {
  readonly broker: CredentialVaultRelay;
  readonly environmentId: EnvironmentId;
  readonly request: PreviewCredentialRemoveInput;
}) =>
  input.broker
    .manageCredentials({
      environmentId: input.environmentId,
      command: { action: "remove", id: input.request.id },
    })
    .pipe(Effect.asVoid);

/** Settings → Accounts from any client: who is signed in to the desktop's browser profiles. */
export const remoteAccountsSnapshot = (input: {
  readonly broker: CredentialVaultRelay;
  readonly environmentId: EnvironmentId;
  readonly refresh: boolean;
}) =>
  input.broker
    .manageCredentials({
      environmentId: input.environmentId,
      command: { action: "accountsSnapshot", refresh: input.refresh },
    })
    .pipe(
      Effect.flatMap((result) => decodeAccounts(result).pipe(Effect.mapError(unreadableAnswer))),
    );

export const remoteAccountsSignOut = (input: {
  readonly broker: CredentialVaultRelay;
  readonly environmentId: EnvironmentId;
  readonly signOut: PreviewAccountSignOutInput;
}) =>
  input.broker
    .manageCredentials({
      environmentId: input.environmentId,
      command: { action: "accountsSignOut", signOut: input.signOut },
    })
    .pipe(Effect.asVoid);

export const remoteAccountsLink = (input: {
  readonly broker: CredentialVaultRelay;
  readonly environmentId: EnvironmentId;
  readonly link: PreviewAccountLinkInput;
}) =>
  input.broker
    .manageCredentials({
      environmentId: input.environmentId,
      command: { action: "accountsLink", link: input.link },
    })
    .pipe(Effect.asVoid);
