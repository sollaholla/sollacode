import { assert, describe, it } from "@effect/vitest";

import { shouldBundleCliDependency, shouldEmitSourceMaps } from "./vite.config.ts";

it("bundles the CommonJS terminal parser and serializer for Electron and Node", () => {
  assert.isTrue(shouldBundleCliDependency("@xterm/headless"));
  assert.isTrue(shouldBundleCliDependency("@xterm/addon-serialize/lib/addon-serialize.js"));
  assert.isFalse(shouldBundleCliDependency("node-pty"));
});

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
