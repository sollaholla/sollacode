import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as ElectronSafeStorage from "../electron/ElectronSafeStorage.ts";
import * as BrowserCredentialVault from "./BrowserCredentialVault.ts";

const textDecoder = new TextDecoder();
const textEncoder = new TextEncoder();

function testLayer(baseDir: string, encryptionAvailable = true) {
  const environment = DesktopEnvironment.layer({
    dirname: "/repo/apps/desktop/src",
    homeDirectory: baseDir,
    platform: "darwin",
    processArch: "arm64",
    appVersion: "1.2.3",
    appPath: "/repo",
    isPackaged: true,
    resourcesPath: "/repo/resources",
    runningUnderArm64Translation: false,
  }).pipe(
    Layer.provide(
      Layer.mergeAll(NodeServices.layer, DesktopConfig.layerTest({ T3CODE_HOME: baseDir })),
    ),
  );
  const safeStorage = Layer.succeed(ElectronSafeStorage.ElectronSafeStorage, {
    isEncryptionAvailable: Effect.succeed(encryptionAvailable),
    encryptString: (value) => Effect.succeed(textEncoder.encode(`protected:${value}`)),
    decryptString: (value) => {
      const stored = textDecoder.decode(value);
      return Effect.succeed(stored.slice("protected:".length));
    },
  } satisfies ElectronSafeStorage.ElectronSafeStorage["Service"]);
  return BrowserCredentialVault.layer.pipe(
    Layer.provideMerge(Layer.mergeAll(environment, safeStorage, NodeServices.layer)),
  );
}

const withVault = <A, E, R>(
  effect: Effect.Effect<A, E, R | BrowserCredentialVault.BrowserCredentialVault>,
  encryptionAvailable = true,
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const baseDir = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "solla-browser-credential-test-",
    });
    return yield* effect.pipe(Effect.provide(testLayer(baseDir, encryptionAvailable)));
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped);

describe("BrowserCredentialVault", () => {
  it.effect("stores only encrypted bytes and releases secrets for the exact origin", () =>
    withVault(
      Effect.gen(function* () {
        const vault = yield* BrowserCredentialVault.BrowserCredentialVault;
        const environment = yield* DesktopEnvironment.DesktopEnvironment;
        const fileSystem = yield* FileSystem.FileSystem;
        const saved = yield* vault.save({
          label: "Example login",
          origin: "https://accounts.example.com/path",
          username: "person@example.com",
          secret: "never-write-this",
        });

        const raw = yield* fileSystem.readFileString(environment.browserCredentialVaultPath);
        assert.strictEqual(raw.includes("never-write-this"), false);
        assert.strictEqual(raw.includes("protected:"), false);
        assert.strictEqual(saved.origin, "https://accounts.example.com");

        const matching = yield* vault.listForUrl("https://accounts.example.com/login");
        assert.deepStrictEqual(matching, [saved]);
        const resolved = yield* vault.resolveForUrl(saved.id, "https://accounts.example.com/login");
        assert.strictEqual(resolved.secret, "never-write-this");

        const mismatch = yield* Effect.flip(
          vault.resolveForUrl(saved.id, "https://other.example.com/login"),
        );
        assert.strictEqual(mismatch._tag, "BrowserCredentialNotFoundError");
      }),
    ),
  );

  it.effect("edits an entry without resending its password", () =>
    withVault(
      Effect.gen(function* () {
        const vault = yield* BrowserCredentialVault.BrowserCredentialVault;
        const saved = yield* vault.save({
          label: "Example login",
          origin: "https://example.com",
          username: "old@example.com",
          secret: "kept-secret",
        });

        const edited = yield* vault.save({
          id: saved.id,
          label: "Work login",
          origin: "https://accounts.example.com/signin",
          username: "new@example.com",
        });
        assert.strictEqual(edited.id, saved.id);
        assert.strictEqual(edited.label, "Work login");
        assert.strictEqual(edited.origin, "https://accounts.example.com");
        assert.strictEqual(edited.username, "new@example.com");
        assert.strictEqual(edited.createdAt, saved.createdAt);
        assert.deepStrictEqual(yield* vault.list, [edited]);

        const resolved = yield* vault.resolveForUrl(saved.id, "https://accounts.example.com/x");
        assert.strictEqual(resolved.secret, "kept-secret");

        const orphan = yield* Effect.flip(
          vault.save({
            id: "missing" as typeof saved.id,
            label: "Nothing to keep",
            origin: "https://example.com",
          }),
        );
        assert.strictEqual(orphan._tag, "BrowserCredentialNotFoundError");
        const unkeyed = yield* Effect.flip(
          vault.save({ label: "No password", origin: "https://example.com" }),
        );
        assert.strictEqual(unkeyed._tag, "BrowserCredentialNotFoundError");
      }),
    ),
  );

  it.effect("keeps a PIN's kind across edits and reads older entries as passwords", () =>
    withVault(
      Effect.gen(function* () {
        const vault = yield* BrowserCredentialVault.BrowserCredentialVault;
        const environment = yield* DesktopEnvironment.DesktopEnvironment;
        const fileSystem = yield* FileSystem.FileSystem;
        // A vault written before kinds existed.
        yield* fileSystem.makeDirectory(
          environment.path.dirname(environment.browserCredentialVaultPath),
          { recursive: true },
        );
        const encryptedSecret = Buffer.from("protected:old").toString("base64");
        yield* fileSystem.writeFileString(
          environment.browserCredentialVaultPath,
          `{"version":1,"credentials":[{"id":"legacy","label":"Legacy login","origin":"https://example.com","createdAt":"2026-09-23T00:00:00.000Z","updatedAt":"2026-09-23T00:00:00.000Z","encryptedSecret":"${encryptedSecret}"}]}\n`,
        );
        const [legacy] = yield* vault.list;
        assert.strictEqual(legacy?.kind, "password");

        const pin = yield* vault.save({
          label: "Payments PIN",
          origin: "https://example.com",
          kind: "code",
          secret: "4821",
        });
        assert.strictEqual(pin.kind, "code");
        const renamed = yield* vault.save({ id: pin.id, label: "Rent PIN", origin: pin.origin });
        assert.strictEqual(renamed.kind, "code");

        // Switching the legacy entry to a code keeps its secret.
        const switched = yield* vault.save({
          id: legacy!.id,
          label: legacy!.label,
          origin: legacy!.origin,
          kind: "code",
        });
        assert.strictEqual(switched.kind, "code");
        const resolved = yield* vault.resolveForUrl(legacy!.id, "https://example.com/pay");
        assert.strictEqual(resolved.secret, "old");
        assert.strictEqual(resolved.summary.kind, "code");
      }),
    ),
  );

  it.effect("refuses to save when operating-system encryption is unavailable", () =>
    withVault(
      Effect.gen(function* () {
        const vault = yield* BrowserCredentialVault.BrowserCredentialVault;
        const error = yield* Effect.flip(
          vault.save({
            label: "Example login",
            origin: "https://example.com",
            secret: "secret",
          }),
        );
        assert.strictEqual(error._tag, "BrowserCredentialEncryptionUnavailableError");
      }),
      false,
    ),
  );

  it("rejects plaintext HTTP origins outside localhost", () => {
    assert.throws(
      () => BrowserCredentialVault.normalizeCredentialOrigin("http://example.com"),
      BrowserCredentialVault.BrowserCredentialOriginError,
    );
    assert.strictEqual(
      BrowserCredentialVault.normalizeCredentialOrigin("http://localhost:5173/path"),
      "http://localhost:5173",
    );
  });
});
