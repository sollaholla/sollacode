import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as ManagedRuntime from "effect/ManagedRuntime";
import { describe, expect, it } from "vite-plus/test";

import { runtime, runtimeContextLayer } from "./runtime";

const assertCryptoService = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const bytes = yield* crypto.randomBytes(16);
  const digest = yield* crypto.digest("SHA-256", bytes);

  expect(bytes).toHaveLength(16);
  expect(digest).toHaveLength(32);
});

describe("renderer runtime", () => {
  it("provides browser crypto directly", async () => {
    await runtime.runPromise(assertCryptoService);
  });

  it("preserves browser crypto when embedded in the connection runtime", async () => {
    const embedded = ManagedRuntime.make(runtimeContextLayer);
    try {
      await embedded.runPromise(assertCryptoService);
    } finally {
      await embedded.dispose();
    }
  });
});
