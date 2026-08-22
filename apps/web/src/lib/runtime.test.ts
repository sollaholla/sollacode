import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "@effect/vitest";

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

  it.effect("preserves browser crypto when embedded in the connection runtime", () =>
    assertCryptoService.pipe(Effect.provide(runtimeContextLayer)),
  );
});
