import {
  PreviewCredentialSummary,
  type PreviewCredentialId,
  type PreviewCredentialKind,
  type PreviewCredentialSummary as PreviewCredentialSummaryType,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";
import * as Schema from "effect/Schema";
import * as NodeCrypto from "node:crypto";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as ElectronSafeStorage from "../electron/ElectronSafeStorage.ts";

interface StoredCredential extends PreviewCredentialSummaryType {
  readonly encryptedSecret: string;
}

interface VaultDocument {
  readonly version: 1;
  readonly credentials: readonly StoredCredential[];
}

const StoredCredentialSchema = Schema.Struct({
  ...PreviewCredentialSummary.fields,
  encryptedSecret: Schema.String,
});
const VaultDocumentSchema = Schema.Struct({
  version: Schema.Literal(1),
  credentials: Schema.Array(StoredCredentialSchema),
});
const VaultDocumentJson = Schema.fromJsonString(VaultDocumentSchema);
const decodeVaultDocument = Schema.decodeEffect(VaultDocumentJson);
const encodeVaultDocument = Schema.encodeEffect(VaultDocumentJson);

export class BrowserCredentialVaultError extends Schema.TaggedErrorClass<BrowserCredentialVaultError>()(
  "BrowserCredentialVaultError",
  {
    operation: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Browser credential vault failed during ${this.operation}.`;
  }
}

export class BrowserCredentialOriginError extends Schema.TaggedErrorClass<BrowserCredentialOriginError>()(
  "BrowserCredentialOriginError",
  {
    reason: Schema.String,
  },
) {
  override get message(): string {
    return this.reason;
  }
}

export class BrowserCredentialNotFoundError extends Schema.TaggedErrorClass<BrowserCredentialNotFoundError>()(
  "BrowserCredentialNotFoundError",
  { credentialId: Schema.String },
) {
  override get message(): string {
    return "The saved browser credential no longer exists.";
  }
}

export class BrowserCredentialEncryptionUnavailableError extends Schema.TaggedErrorClass<BrowserCredentialEncryptionUnavailableError>()(
  "BrowserCredentialEncryptionUnavailableError",
  {},
) {
  override get message(): string {
    return "Secure operating-system encryption is unavailable, so the password was not saved.";
  }
}

export type BrowserCredentialVaultFailure =
  | BrowserCredentialVaultError
  | BrowserCredentialOriginError
  | BrowserCredentialNotFoundError
  | BrowserCredentialEncryptionUnavailableError;

export function normalizeCredentialOrigin(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new BrowserCredentialOriginError({ reason: "Enter a valid website origin." });
  }
  const loopback =
    url.hostname === "localhost" ||
    url.hostname.endsWith(".localhost") ||
    url.hostname === "127.0.0.1" ||
    url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new BrowserCredentialOriginError({
      reason: "Saved passwords require HTTPS, except on localhost.",
    });
  }
  return url.origin;
}

// Entries saved before PINs and codes existed carry no kind: they are passwords.
const metadata = (record: StoredCredential): PreviewCredentialSummaryType => {
  const { encryptedSecret: _, ...summary } = record;
  return { ...summary, kind: record.kind ?? "password" };
};

export interface BrowserCredentialSaveInput {
  readonly id?: PreviewCredentialId;
  readonly label: string;
  readonly origin: string;
  readonly kind?: PreviewCredentialKind;
  readonly username?: string;
  readonly secret?: string;
  readonly ephemeral?: boolean;
}

/** How long a "just this sign-in" entry stays usable. */
const EPHEMERAL_CREDENTIAL_TTL_MS = 60 * 60_000;

/** The entry a new login replaces: same site, same account, same kind of secret. */
const isSameLogin = (
  left: Pick<StoredCredential, "origin" | "kind" | "username" | "label">,
  right: Pick<StoredCredential, "origin" | "kind" | "username" | "label">,
): boolean =>
  left.origin === right.origin &&
  (left.kind ?? "password") === (right.kind ?? "password") &&
  (left.username || right.username ? left.username === right.username : left.label === right.label);

export class BrowserCredentialVault extends Context.Service<
  BrowserCredentialVault,
  {
    readonly list: Effect.Effect<
      readonly PreviewCredentialSummaryType[],
      BrowserCredentialVaultFailure
    >;
    /**
     * Adds an entry, or replaces the one with `id`. Omitting `secret` keeps the
     * existing entry's encrypted password, so a label, username, or origin edit
     * never sends the password back through the renderer. Omitting `kind` keeps
     * the existing entry's kind, and a new entry is a password. A new entry for
     * a login already saved replaces it. `ephemeral` keeps the entry in memory
     * for one sign-in: `list` leaves it out, and it never reaches the file.
     */
    readonly save: (
      input: BrowserCredentialSaveInput,
    ) => Effect.Effect<PreviewCredentialSummaryType, BrowserCredentialVaultFailure>;
    readonly remove: (
      id: PreviewCredentialId,
    ) => Effect.Effect<void, BrowserCredentialVaultFailure>;
    readonly listForUrl: (
      url: string,
    ) => Effect.Effect<readonly PreviewCredentialSummaryType[], BrowserCredentialVaultFailure>;
    readonly resolveForUrl: (
      id: PreviewCredentialId,
      url: string,
    ) => Effect.Effect<
      { readonly summary: PreviewCredentialSummaryType; readonly secret: string },
      BrowserCredentialVaultFailure
    >;
  }
>()("@t3tools/desktop/preview/BrowserCredentialVault") {}

export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const fileSystem = yield* FileSystem.FileSystem;
  const safeStorage = yield* ElectronSafeStorage.ElectronSafeStorage;
  const lock = yield* Semaphore.make(1);
  const vaultPath = environment.browserCredentialVaultPath;
  const ephemeral = new Map<
    string,
    { readonly record: StoredCredential; readonly until: number }
  >();

  /** Entries for one sign-in that are still in date. Their secrets stay encrypted here too. */
  const liveEphemeral = Effect.gen(function* () {
    const now = DateTime.toEpochMillis(yield* DateTime.now);
    for (const [id, entry] of ephemeral) {
      if (entry.until <= now) ephemeral.delete(id);
    }
    return [...ephemeral.values()].map((entry) => entry.record);
  });

  const read = Effect.fn("browserCredentialVault.read")(function* () {
    const exists = yield* fileSystem
      .exists(vaultPath)
      .pipe(
        Effect.mapError((cause) => new BrowserCredentialVaultError({ operation: "read", cause })),
      );
    if (!exists) return { version: 1, credentials: [] } satisfies VaultDocument;
    const raw = yield* fileSystem
      .readFileString(vaultPath)
      .pipe(
        Effect.mapError((cause) => new BrowserCredentialVaultError({ operation: "read", cause })),
      );
    return yield* decodeVaultDocument(raw).pipe(
      Effect.mapError((cause) => new BrowserCredentialVaultError({ operation: "decode", cause })),
    );
  });

  const write = Effect.fn("browserCredentialVault.write")(function* (document: VaultDocument) {
    const suffix = NodeCrypto.randomUUID().replaceAll("-", "");
    const temporaryPath = `${vaultPath}.${process.pid}.${suffix}.tmp`;
    yield* fileSystem
      .makeDirectory(environment.path.dirname(vaultPath), { recursive: true })
      .pipe(
        Effect.mapError(
          (cause) => new BrowserCredentialVaultError({ operation: "create-directory", cause }),
        ),
      );
    const encoded = yield* encodeVaultDocument(document).pipe(
      Effect.mapError((cause) => new BrowserCredentialVaultError({ operation: "encode", cause })),
    );
    yield* fileSystem
      .writeFileString(temporaryPath, `${encoded}\n`)
      .pipe(
        Effect.mapError((cause) => new BrowserCredentialVaultError({ operation: "write", cause })),
      );
    yield* fileSystem
      .chmod(temporaryPath, 0o600)
      .pipe(
        Effect.mapError(
          (cause) => new BrowserCredentialVaultError({ operation: "protect-file", cause }),
        ),
      );
    yield* fileSystem
      .rename(temporaryPath, vaultPath)
      .pipe(
        Effect.mapError(
          (cause) => new BrowserCredentialVaultError({ operation: "replace", cause }),
        ),
      );
  });

  const requireEncryption = safeStorage.isEncryptionAvailable.pipe(
    Effect.mapError(
      (cause) => new BrowserCredentialVaultError({ operation: "check-encryption", cause }),
    ),
    Effect.flatMap((available) =>
      available ? Effect.void : Effect.fail(new BrowserCredentialEncryptionUnavailableError()),
    ),
  );

  const list = lock.withPermits(1)(
    read().pipe(Effect.map((document) => document.credentials.map(metadata))),
  );

  const save = Effect.fn("browserCredentialVault.save")(function* (
    input: BrowserCredentialSaveInput,
  ) {
    const origin = yield* Effect.try({
      try: () => normalizeCredentialOrigin(input.origin),
      catch: (cause) => cause as BrowserCredentialOriginError,
    });
    const document = yield* read();
    const clock = yield* DateTime.now;
    const now = DateTime.formatIso(clock);
    const label = input.label.trim();
    const existing = input.ephemeral
      ? undefined
      : input.id
        ? document.credentials.find((credential) => credential.id === input.id)
        : document.credentials.find((credential) =>
            isSameLogin(credential, {
              origin,
              kind: input.kind ?? "password",
              label,
              ...(input.username === undefined ? {} : { username: input.username }),
            }),
          );
    let encryptedSecret: string;
    if (input.secret === undefined) {
      if (!existing) {
        return yield* new BrowserCredentialNotFoundError({ credentialId: input.id ?? "" });
      }
      encryptedSecret = existing.encryptedSecret;
    } else {
      yield* requireEncryption;
      encryptedSecret = Buffer.from(
        yield* safeStorage
          .encryptString(input.secret)
          .pipe(
            Effect.mapError(
              (cause) => new BrowserCredentialVaultError({ operation: "encrypt", cause }),
            ),
          ),
      ).toString("base64");
    }
    const record: StoredCredential = {
      id: (input.id ?? existing?.id ?? NodeCrypto.randomUUID()) as PreviewCredentialId,
      label,
      origin,
      kind: input.kind ?? existing?.kind ?? "password",
      ...(input.username === undefined ? {} : { username: input.username }),
      ...(input.ephemeral ? { ephemeral: true } : {}),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      encryptedSecret,
    };
    if (input.ephemeral) {
      ephemeral.set(record.id, {
        record,
        until: DateTime.toEpochMillis(clock) + EPHEMERAL_CREDENTIAL_TTL_MS,
      });
      return metadata(record);
    }
    yield* write({
      version: 1,
      credentials: [...document.credentials.filter((item) => item.id !== record.id), record],
    });
    return metadata(record);
  });

  const remove = Effect.fn("browserCredentialVault.remove")(function* (id: PreviewCredentialId) {
    ephemeral.delete(id);
    const document = yield* read();
    yield* write({
      version: 1,
      credentials: document.credentials.filter((credential) => credential.id !== id),
    });
  });

  const listForUrl = Effect.fn("browserCredentialVault.listForUrl")(function* (url: string) {
    const origin = yield* Effect.try({
      try: () => normalizeCredentialOrigin(url),
      catch: (cause) => cause as BrowserCredentialOriginError,
    });
    const document = yield* read();
    return [...document.credentials, ...(yield* liveEphemeral)]
      .filter((record) => record.origin === origin)
      .map(metadata);
  });

  const resolveForUrl = Effect.fn("browserCredentialVault.resolveForUrl")(function* (
    id: PreviewCredentialId,
    url: string,
  ) {
    yield* requireEncryption;
    const origin = yield* Effect.try({
      try: () => normalizeCredentialOrigin(url),
      catch: (cause) => cause as BrowserCredentialOriginError,
    });
    const record = [...(yield* read()).credentials, ...(yield* liveEphemeral)].find(
      (credential) => credential.id === id,
    );
    if (!record || record.origin !== origin) {
      return yield* new BrowserCredentialNotFoundError({ credentialId: id });
    }
    const secret = yield* safeStorage
      .decryptString(Buffer.from(record.encryptedSecret, "base64"))
      .pipe(
        Effect.mapError(
          (cause) => new BrowserCredentialVaultError({ operation: "decrypt", cause }),
        ),
      );
    return { summary: metadata(record), secret };
  });

  return BrowserCredentialVault.of({
    list,
    save: (input) => lock.withPermits(1)(save(input)),
    remove: (id) => lock.withPermits(1)(remove(id)),
    listForUrl: (url) => lock.withPermits(1)(listForUrl(url)),
    resolveForUrl: (id, url) => lock.withPermits(1)(resolveForUrl(id, url)),
  });
});

export const layer = Layer.effect(BrowserCredentialVault, make);
