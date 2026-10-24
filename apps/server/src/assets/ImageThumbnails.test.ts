// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeZlib from "node:zlib";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../config.ts";
import { ImageThumbnails, isThumbnailSourcePath, layer } from "./ImageThumbnails.ts";

/** A noisy RGB PNG, so it compresses poorly and is well over the thumbnail threshold. */
function noisyPng(width: number, height: number): Buffer {
  // Each row: filter byte 0, then random RGB, which deflate cannot shrink.
  const rows = Array.from({ length: height }, () =>
    Buffer.concat([Buffer.alloc(1), NodeCrypto.randomBytes(width * 3)]),
  );
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc32 = (bytes: Buffer) => {
    let c = 0xffffffff;
    for (const byte of bytes) c = crcTable[(c ^ byte) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const head = Buffer.alloc(4);
    head.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const tail = Buffer.alloc(4);
    tail.writeUInt32BE(crc32(body));
    return Buffer.concat([head, body, tail]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", NodeZlib.deflateSync(Buffer.concat(rows))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

describe("image thumbnails", () => {
  it("only resizes formats sips reads", () => {
    expect(isThumbnailSourcePath("/tmp/shot.PNG")).toBe(true);
    expect(isThumbnailSourcePath("/tmp/photo.heic")).toBe(true);
    expect(isThumbnailSourcePath("/tmp/icon.svg")).toBe(false);
    expect(isThumbnailSourcePath("/tmp/favicon.ico")).toBe(false);
    expect(isThumbnailSourcePath("/tmp/no-extension")).toBe(false);
  });

  it.effect("sends a small cached JPEG for a large image and the original for a small one", () =>
    Effect.gen(function* () {
      // `sips` ships with macOS only; elsewhere the original is always sent.
      if ((yield* HostProcessPlatform) !== "darwin") return;
      const baseDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-thumbnails-")),
      );
      const large = NodePath.join(baseDir, "large.png");
      const small = NodePath.join(baseDir, "small.png");
      yield* Effect.promise(() => NodeFSP.writeFile(large, noisyPng(400, 300)));
      yield* Effect.promise(() => NodeFSP.writeFile(small, noisyPng(8, 8)));
      expect((yield* Effect.promise(() => NodeFSP.stat(large))).size).toBeGreaterThan(300_000);

      const thumbnails = yield* ImageThumbnails.pipe(
        Effect.provide(
          layer.pipe(
            Layer.provide(ServerConfig.layerTest(baseDir, baseDir)),
            Layer.provide(NodeServices.layer),
          ),
        ),
      );
      const first = yield* thumbnails.thumbnail(large);
      expect(first).not.toBeNull();
      // A JPEG, and far smaller than the 360 KB original.
      expect([...first!.subarray(0, 2)]).toEqual([0xff, 0xd8]);
      expect(first!.byteLength).toBeLessThan(100_000);
      // The second request is served from the cache, byte for byte.
      expect(yield* thumbnails.thumbnail(large)).toEqual(first);
      expect(yield* thumbnails.thumbnail(small)).toBeNull();
      expect(yield* thumbnails.thumbnail(NodePath.join(baseDir, "missing.png"))).toBeNull();
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
