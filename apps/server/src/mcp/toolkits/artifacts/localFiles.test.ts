// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { isInside, resolveArtifactLocalPath } from "./localFiles.ts";

const ROOT = NodePath.resolve("/tmp/artifact-bundle");

function resolve(localPath: string, localDir: string | undefined = ROOT) {
  return resolveArtifactLocalPath({ localPath, localDir });
}

describe("resolveArtifactLocalPath", () => {
  it("resolves a relative path inside the directory", () => {
    expect(resolve("img/hero.webp")).toEqual({
      ok: true,
      absolutePath: NodePath.join(ROOT, "img/hero.webp"),
    });
  });

  it("accepts an absolute path that already points inside", () => {
    const inside = NodePath.join(ROOT, "index.html");
    expect(resolve(inside)).toEqual({ ok: true, absolutePath: inside });
  });

  it("refuses to walk out with ..", () => {
    const result = resolve("../../etc/passwd");
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.rejection.kind).toBe("escapes-local-dir");
  });

  it("refuses an absolute path outside the directory", () => {
    const result = resolve("/etc/passwd");
    expect(result.ok === false && result.rejection.kind).toBe("escapes-local-dir");
  });

  it("refuses a sibling directory that merely shares a prefix", () => {
    // A string-prefix check would let this through.
    const result = resolve(`${ROOT}-evil/secret.txt`);
    expect(result.ok === false && result.rejection.kind).toBe("escapes-local-dir");
  });

  it("requires localDir to be named at all", () => {
    // Called directly: the helper's default would mask an omitted localDir.
    const omitted = resolveArtifactLocalPath({ localPath: "img/hero.webp", localDir: undefined });
    expect(omitted.ok).toBe(false);
    expect(omitted.ok === false && omitted.rejection.kind).toBe("missing-local-dir");
    expect(resolve("img/hero.webp", "   ").ok).toBe(false);
  });

  it("rejects an empty path rather than resolving to the directory itself", () => {
    const result = resolve("   ");
    expect(result.ok === false && result.rejection.kind).toBe("empty");
  });

  it("normalises redundant segments without treating them as an escape", () => {
    expect(resolve("./img/../img/hero.webp")).toEqual({
      ok: true,
      absolutePath: NodePath.join(ROOT, "img/hero.webp"),
    });
  });
});

describe("isInside", () => {
  it("counts the directory itself as inside", () => {
    expect(isInside(ROOT, ROOT)).toBe(true);
  });

  it("compares segments, not string prefixes", () => {
    expect(isInside(ROOT, `${ROOT}-evil`)).toBe(false);
    expect(isInside(ROOT, NodePath.join(ROOT, "nested/deep.txt"))).toBe(true);
  });

  it("rejects a parent", () => {
    expect(isInside(ROOT, NodePath.dirname(ROOT))).toBe(false);
  });
});

describe("isInside with a symlinked root", () => {
  it("matches once both sides are resolved", () => {
    // /tmp is a link to /private/tmp on macOS. Resolving only the file side
    // makes every path beneath it look like an escape — which it did, and the
    // first real bundle publish failed on exactly this.
    expect(isInside("/private/tmp/ap", "/private/tmp/ap/index.html")).toBe(true);
    expect(isInside("/tmp/ap", "/private/tmp/ap/index.html")).toBe(false);
  });
});
