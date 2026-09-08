import {
  PreviewCredentialSummary,
  type PreviewCredentialId,
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

const metadata = (record: StoredCredential): PreviewCredentialSummaryType => {
  const { encryptedSecret: _, ...summary } = record;
  return summary;
};

export class BrowserCredentialVault extends Context.Service<
  BrowserCredentialVault,
  {
    readonly list: Effect.Effect<
      readonly PreviewCredentialSummaryType[],
      BrowserCredentialVaultFailure
    >;
    readonly save: (input: {
      readonly id?: PreviewCredentialId;
      readonly label: string;
      readonly origin: string;
      readonly username?: string;
      readonly secret: string;
    }) => Effect.Effect<PreviewCredentialSummaryType, BrowserCredentialVaultFailure>;
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

  const save = Effect.fn("browserCredentialVault.save")(function* (input: {
    readonly id?: PreviewCredentialId;
    readonly label: string;
    readonly origin: string;
    readonly username?: string;
    readonly secret: string;
  }) {
    yield* requireEncryption;
    const origin = yield* Effect.try({
      try: () => normalizeCredentialOrigin(input.origin),
      catch: (cause) => cause as BrowserCredentialOriginError,
    });
    const document = yield* read();
    const now = DateTime.formatIso(yield* DateTime.now);
    const existing = input.id
      ? document.credentials.find((credential) => credential.id === input.id)
      : undefined;
    const encryptedSecret = Buffer.from(
      yield* safeStorage
        .encryptString(input.secret)
        .pipe(
          Effect.mapError(
            (cause) => new BrowserCredentialVaultError({ operation: "encrypt", cause }),
          ),
        ),
    ).toString("base64");
    const record: StoredCredential = {
      id: (input.id ?? NodeCrypto.randomUUID()) as PreviewCredentialId,
      label: input.label.trim(),
      origin,
      ...(input.username === undefined ? {} : { username: input.username }),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      encryptedSecret,
    };
    yield* write({
      version: 1,
      credentials: [...document.credentials.filter((item) => item.id !== record.id), record],
    });
    return metadata(record);
  });

  const remove = Effect.fn("browserCredentialVault.remove")(function* (id: PreviewCredentialId) {
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
    return document.credentials.filter((record) => record.origin === origin).map(metadata);
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
    const record = (yield* read()).credentials.find((credential) => credential.id === id);
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
