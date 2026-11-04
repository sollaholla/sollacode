import {
  PreviewPasskeySummary,
  type PreviewPasskeysSnapshot,
  type PreviewPasskeySummary as PreviewPasskeySummaryType,
} from "@t3tools/contracts";
import {
  isPasskeySiteRefused,
  passkeySiteForUrl,
  passkeySiteFromInput,
} from "@t3tools/shared/passkeySites";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as NodeCrypto from "node:crypto";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as ElectronSafeStorage from "../electron/ElectronSafeStorage.ts";
import { passkeyIdKey, type PasskeyCdpCredential } from "./passkeyAuthenticator.ts";

const StoredPasskey = Schema.Struct({
  ...PreviewPasskeySummary.fields,
  encryptedKey: Schema.String,
  isResidentCredential: Schema.Boolean,
  userHandle: Schema.optionalKey(Schema.String),
  signCount: Schema.Number,
  backupEligibility: Schema.optionalKey(Schema.Boolean),
  backupState: Schema.optionalKey(Schema.Boolean),
});
type StoredPasskey = typeof StoredPasskey.Type;

const VaultDocument = Schema.Struct({
  version: Schema.Literal(1),
  sites: Schema.Array(Schema.String),
  passkeys: Schema.Array(StoredPasskey),
});
type VaultDocument = typeof VaultDocument.Type;

const VaultDocumentJson = Schema.fromJsonString(VaultDocument);
const decodeDocument = Schema.decodeEffect(VaultDocumentJson);
const encodeDocument = Schema.encodeEffect(VaultDocumentJson);

export class BrowserPasskeyVaultError extends Schema.TaggedErrorClass<BrowserPasskeyVaultError>()(
  "BrowserPasskeyVaultError",
  { operation: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Passkey storage failed during ${this.operation}.`;
  }
}

export class BrowserPasskeySiteError extends Schema.TaggedErrorClass<BrowserPasskeySiteError>()(
  "BrowserPasskeySiteError",
  { reason: Schema.String },
) {
  override get message(): string {
    return this.reason;
  }
}

export type BrowserPasskeyVaultFailure = BrowserPasskeyVaultError | BrowserPasskeySiteError;

const summaryOf = (record: StoredPasskey): PreviewPasskeySummaryType => ({
  id: record.id,
  rpId: record.rpId,
  ...(record.userName === undefined ? {} : { userName: record.userName }),
  ...(record.userDisplayName === undefined ? {} : { userDisplayName: record.userDisplayName }),
  createdAt: record.createdAt,
});

/** Whether a passkey made for `rpId` is one a page on `host` may ask for. */
const passkeyFitsHost = (rpId: string, host: string): boolean =>
  host === rpId || host.endsWith(`.${rpId}`);

export class BrowserPasskeyVault extends Context.Service<
  BrowserPasskeyVault,
  {
    /** Which sites are on and what is held. Private keys never leave this service. */
    readonly snapshot: Effect.Effect<PreviewPasskeysSnapshot, BrowserPasskeyVaultFailure>;
    readonly setSite: (input: {
      readonly site: string;
      readonly enabled: boolean;
    }) => Effect.Effect<PreviewPasskeysSnapshot, BrowserPasskeyVaultFailure>;
    readonly remove: (
      id: string,
    ) => Effect.Effect<PreviewPasskeysSnapshot, BrowserPasskeyVaultFailure>;
    readonly isOnForUrl: (url: string) => Effect.Effect<boolean, BrowserPasskeyVaultFailure>;
    /** Decrypted for the authenticator of a page at `url`, and for nothing else. */
    readonly credentialsForUrl: (
      url: string,
    ) => Effect.Effect<ReadonlyArray<PasskeyCdpCredential>, BrowserPasskeyVaultFailure>;
    /** Keeps what the authenticator just made, or the newer sign count of one it used. */
    readonly capture: (
      credential: PasskeyCdpCredential,
    ) => Effect.Effect<void, BrowserPasskeyVaultFailure>;
    /** When a passkey was made, whichever form of its id the asker has. */
    readonly createdAt: (id: string) => string | undefined;
  }
>()("@t3tools/desktop/preview/BrowserPasskeyVault") {}

export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const fileSystem = yield* FileSystem.FileSystem;
  const safeStorage = yield* ElectronSafeStorage.ElectronSafeStorage;
  const lock = yield* Semaphore.make(1);
  const vaultPath = environment.browserPasskeyVaultPath;
  const failed = (operation: string) => (cause: unknown) =>
    new BrowserPasskeyVaultError({ operation, cause });

  // Read once: navigation asks on every commit, and this file has one writer.
  let loaded: VaultDocument | null = null;

  const read = Effect.gen(function* () {
    if (loaded !== null) return loaded;
    const exists = yield* fileSystem.exists(vaultPath).pipe(Effect.mapError(failed("read")));
    loaded = exists
      ? yield* fileSystem.readFileString(vaultPath).pipe(
          Effect.mapError(failed("read")),
          Effect.flatMap((raw) => decodeDocument(raw).pipe(Effect.mapError(failed("decode")))),
        )
      : { version: 1 as const, sites: [], passkeys: [] };
    return loaded;
  });

  const write = Effect.fn("browserPasskeyVault.write")(function* (document: VaultDocument) {
    const temporaryPath = `${vaultPath}.${process.pid}.${NodeCrypto.randomUUID()}.tmp`;
    yield* fileSystem
      .makeDirectory(environment.path.dirname(vaultPath), { recursive: true })
      .pipe(Effect.mapError(failed("create-directory")));
    const encoded = yield* encodeDocument(document).pipe(Effect.mapError(failed("encode")));
    yield* fileSystem
      .writeFileString(temporaryPath, `${encoded}\n`)
      .pipe(Effect.mapError(failed("write")));
    yield* fileSystem.chmod(temporaryPath, 0o600).pipe(Effect.mapError(failed("protect-file")));
    yield* fileSystem.rename(temporaryPath, vaultPath).pipe(Effect.mapError(failed("replace")));
    loaded = document;
  });

  const snapshotOf = (document: VaultDocument): PreviewPasskeysSnapshot => ({
    sites: document.sites,
    passkeys: document.passkeys.map(summaryOf),
  });

  const setSite = Effect.fn("browserPasskeyVault.setSite")(function* (input: {
    readonly site: string;
    readonly enabled: boolean;
  }) {
    const site = passkeySiteFromInput(input.site);
    if (site === null) {
      return yield* new BrowserPasskeySiteError({
        reason: "Enter a website that uses HTTPS, or a local address.",
      });
    }
    if (input.enabled && isPasskeySiteRefused(site)) {
      return yield* new BrowserPasskeySiteError({
        reason: "Google refuses a browser that can hold passkeys this way. Sign in to it yourself.",
      });
    }
    const document = yield* read;
    const others = document.sites.filter((entry) => entry !== site);
    const next = { ...document, sites: input.enabled ? [...others, site] : others };
    yield* write(next);
    return snapshotOf(next);
  });

  const remove = Effect.fn("browserPasskeyVault.remove")(function* (id: string) {
    const document = yield* read;
    const next = { ...document, passkeys: document.passkeys.filter((entry) => entry.id !== id) };
    yield* write(next);
    return snapshotOf(next);
  });

  const isOnForUrl = Effect.fn("browserPasskeyVault.isOnForUrl")(function* (url: string) {
    const site = passkeySiteForUrl(url);
    if (site === null) return false;
    return (yield* read).sites.includes(site);
  });

  const credentialsForUrl = Effect.fn("browserPasskeyVault.credentialsForUrl")(function* (
    url: string,
  ) {
    if (!(yield* isOnForUrl(url))) return [];
    const { hostname } = new URL(url);
    const fitting = (yield* read).passkeys.filter((entry) => passkeyFitsHost(entry.rpId, hostname));
    return yield* Effect.forEach(fitting, (entry) =>
      safeStorage.decryptString(Buffer.from(entry.encryptedKey, "base64")).pipe(
        Effect.mapError(failed("decrypt")),
        Effect.map(
          (privateKey): PasskeyCdpCredential => ({
            credentialId: entry.id,
            isResidentCredential: entry.isResidentCredential,
            rpId: entry.rpId,
            privateKey,
            signCount: entry.signCount,
            ...(entry.userHandle === undefined ? {} : { userHandle: entry.userHandle }),
            ...(entry.userName === undefined ? {} : { userName: entry.userName }),
            ...(entry.userDisplayName === undefined
              ? {}
              : { userDisplayName: entry.userDisplayName }),
            ...(entry.backupEligibility === undefined
              ? {}
              : { backupEligibility: entry.backupEligibility }),
            ...(entry.backupState === undefined ? {} : { backupState: entry.backupState }),
          }),
        ),
      ),
    );
  });

  const capture = Effect.fn("browserPasskeyVault.capture")(function* (
    credential: PasskeyCdpCredential,
  ) {
    const { rpId } = credential;
    if (!rpId) return;
    const document = yield* read;
    const existing = document.passkeys.find((entry) => entry.id === credential.credentialId);
    // Restoring a passkey into a new page reports it back unchanged.
    if (existing && existing.signCount >= credential.signCount) return;
    const now = DateTime.formatIso(yield* DateTime.now);
    const available = yield* safeStorage.isEncryptionAvailable.pipe(
      Effect.mapError(failed("check-encryption")),
    );
    if (!available) {
      return yield* new BrowserPasskeySiteError({
        reason: "Secure operating-system encryption is unavailable, so the passkey was not kept.",
      });
    }
    const encryptedKey =
      existing?.encryptedKey ??
      Buffer.from(
        yield* safeStorage
          .encryptString(credential.privateKey)
          .pipe(Effect.mapError(failed("encrypt"))),
      ).toString("base64");
    const record: StoredPasskey = {
      id: credential.credentialId,
      rpId,
      createdAt: existing?.createdAt ?? now,
      encryptedKey,
      isResidentCredential: credential.isResidentCredential,
      signCount: credential.signCount,
      ...(credential.userName ? { userName: credential.userName } : {}),
      ...(credential.userDisplayName ? { userDisplayName: credential.userDisplayName } : {}),
      ...(credential.userHandle ? { userHandle: credential.userHandle } : {}),
      ...(credential.backupEligibility === undefined
        ? {}
        : { backupEligibility: credential.backupEligibility }),
      ...(credential.backupState === undefined ? {} : { backupState: credential.backupState }),
    };
    yield* write({
      ...document,
      passkeys: [...document.passkeys.filter((entry) => entry.id !== record.id), record],
    });
  });

  return BrowserPasskeyVault.of({
    snapshot: lock.withPermits(1)(read.pipe(Effect.map(snapshotOf))),
    setSite: (input) => lock.withPermits(1)(setSite(input)),
    remove: (id) => lock.withPermits(1)(remove(id)),
    isOnForUrl: (url) => lock.withPermits(1)(isOnForUrl(url)),
    credentialsForUrl: (url) => lock.withPermits(1)(credentialsForUrl(url)),
    capture: (credential) => lock.withPermits(1)(capture(credential)),
    createdAt: (id) => {
      const key = passkeyIdKey(id);
      return loaded?.passkeys.find((entry) => passkeyIdKey(entry.id) === key)?.createdAt;
    },
  });
});

export const layer = Layer.effect(BrowserPasskeyVault, make);
