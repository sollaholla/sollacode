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
