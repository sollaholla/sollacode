import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as ElectronSafeStorage from "../electron/ElectronSafeStorage.ts";
import * as BrowserPasskeyVault from "./BrowserPasskeyVault.ts";
import {
  passkeyCredentialFromEvent,
  passkeyIdKey,
  pickPasskeyAccount,
} from "./passkeyAuthenticator.ts";

const textDecoder = new TextDecoder();
const textEncoder = new TextEncoder();

function testLayer(baseDir: string) {
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
    isEncryptionAvailable: Effect.succeed(true),
    encryptString: (value) => Effect.succeed(textEncoder.encode(`sealed:${value}`)),
    decryptString: (value) => Effect.succeed(textDecoder.decode(value).slice("sealed:".length)),
  } satisfies ElectronSafeStorage.ElectronSafeStorage["Service"]);
  return BrowserPasskeyVault.layer.pipe(
    Layer.provideMerge(Layer.mergeAll(environment, safeStorage, NodeServices.layer)),
  );
}

const withVault = <A, E, R>(
  effect: Effect.Effect<A, E, R | BrowserPasskeyVault.BrowserPasskeyVault>,
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const baseDir = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "solla-browser-passkey-test-",
    });
    return yield* effect.pipe(Effect.provide(testLayer(baseDir)));
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped);

const credential = {
  credentialId: "credential+1/=",
  isResidentCredential: true,
  rpId: "example.com",
  privateKey: "never-write-this-key",
  userHandle: "AQID",
  signCount: 1,
  userName: "person@example.com",
} as const;

describe("BrowserPasskeyVault", () => {
  it.effect("keeps a key encrypted and gives it only to pages it fits", () =>
    withVault(
      Effect.gen(function* () {
        const vault = yield* BrowserPasskeyVault.BrowserPasskeyVault;
        const environment = yield* DesktopEnvironment.DesktopEnvironment;
        const fileSystem = yield* FileSystem.FileSystem;
        yield* vault.setSite({ site: "login.example.com", enabled: true });
        yield* vault.capture(credential);

        const raw = yield* fileSystem.readFileString(environment.browserPasskeyVaultPath);
        assert.strictEqual(raw.includes(credential.privateKey), false);
        const snapshot = yield* vault.snapshot;
        assert.deepStrictEqual(snapshot.sites, ["example.com"]);
        assert.deepStrictEqual(Object.keys(snapshot.passkeys[0] ?? {}).toSorted(), [
          "createdAt",
          "id",
          "rpId",
          "userName",
        ]);
        assert.strictEqual(snapshot.passkeys[0]?.userName, "person@example.com");

        const onPage = yield* vault.credentialsForUrl("https://login.example.com/start");
        assert.strictEqual(onPage[0]?.privateKey, credential.privateKey);
        assert.deepStrictEqual(yield* vault.credentialsForUrl("https://other.example.org/"), []);
        assert.strictEqual(yield* vault.isOnForUrl("https://app.example.com/"), true);
        assert.strictEqual(yield* vault.isOnForUrl("http://app.example.com/"), false);
        assert.strictEqual(yield* vault.isOnForUrl("https://other.example.org/"), false);
      }),
    ),
  );

  it.effect("keeps a newer sign count, ignores a restored echo, survives a site going off", () =>
    withVault(
      Effect.gen(function* () {
        const vault = yield* BrowserPasskeyVault.BrowserPasskeyVault;
        yield* vault.setSite({ site: "example.com", enabled: true });
        yield* vault.capture(credential);
        // Restoring reports the same count back, which is not worth a write.
        yield* vault.capture({ ...credential, signCount: 2 });
        yield* vault.capture({ ...credential, privateKey: "other-key", signCount: 2 });
        const [restored] = yield* vault.credentialsForUrl("https://example.com/");
        assert.strictEqual(restored?.signCount, 2);
        assert.strictEqual(restored?.privateKey, credential.privateKey);
        // The account picker writes the same id in base64url.
        assert.notStrictEqual(vault.createdAt("credential+1/="), undefined);

        const off = yield* vault.setSite({ site: "example.com", enabled: false });
        assert.deepStrictEqual(off.sites, []);
        assert.strictEqual(off.passkeys.length, 1);
        assert.deepStrictEqual(yield* vault.credentialsForUrl("https://example.com/"), []);

        const removed = yield* vault.remove(credential.credentialId);
        assert.strictEqual(removed.passkeys.length, 0);
      }),
    ),
  );

  it.effect("refuses Google, whose sign-in rejects the debugger this needs", () =>
    withVault(
      Effect.gen(function* () {
        const vault = yield* BrowserPasskeyVault.BrowserPasskeyVault;
        const refused = yield* Effect.flip(
          vault.setSite({ site: "https://accounts.google.com/", enabled: true }),
        );
        assert.strictEqual(refused._tag, "BrowserPasskeySiteError");
        assert.deepStrictEqual((yield* vault.snapshot).sites, []);
      }),
    ),
  );
});

describe("passkey helpers", () => {
  it("answers with the newest account", () => {
    const made: Record<string, string> = {
      a: "2026-11-01T00:00:00.000Z",
      b: "2026-11-02T00:00:00.000Z",
    };
    assert.strictEqual(
      pickPasskeyAccount([{ credentialId: "a" }, { credentialId: "b" }], (id) => made[id]),
      "b",
    );
    assert.strictEqual(
      pickPasskeyAccount([{ credentialId: "c" }], () => undefined),
      "c",
    );
    assert.strictEqual(
      pickPasskeyAccount([], () => undefined),
      null,
    );
  });

  it("matches an id across its two encodings", () => {
    assert.strictEqual(passkeyIdKey("4+js/vtA="), passkeyIdKey("4-js_vtA"));
  });

  it("reads only complete credentials from an event", () => {
    assert.strictEqual(passkeyCredentialFromEvent({ credential: { credentialId: "a" } }), null);
    assert.strictEqual(passkeyCredentialFromEvent({}), null);
    assert.strictEqual(
      passkeyCredentialFromEvent({ credential })?.credentialId,
      credential.credentialId,
    );
  });
});
