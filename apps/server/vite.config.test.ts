import { assert, describe, it } from "@effect/vitest";

import { shouldEmitSourceMaps } from "./vite.config.ts";

describe("server build source maps", () => {
  it("defaults shipping builds to no source maps", () => {
    assert.isFalse(shouldEmitSourceMaps(undefined));
    assert.isFalse(shouldEmitSourceMaps("false"));
  });

  it("allows explicit diagnostic source-map builds", () => {
    assert.isTrue(shouldEmitSourceMaps("1"));
    assert.isTrue(shouldEmitSourceMaps("true"));
    assert.isTrue(shouldEmitSourceMaps("TRUE"));
  });
});
