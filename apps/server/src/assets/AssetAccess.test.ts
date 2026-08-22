import * as NodeOS from "node:os";

import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EventId,
  MessageId,
  ThreadArtifactId,
  ThreadId,
  type OrchestrationMessage,
  type OrchestrationThreadActivity,
} from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { PROJECT_FAVICON_FALLBACK_MARKER } from "@t3tools/shared/projectFavicon";
import { describe, expect, it } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as TestClock from "effect/testing/TestClock";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import { HEIC_FIXTURE_BASE64 } from "../modelImageCompatibility.test-fixture.ts";
import * as ProjectFaviconResolver from "../project/ProjectFaviconResolver.ts";
import * as T3ProjectFileLoader from "../project/T3ProjectFileLoader.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import { encodeArtifactManifest } from "../artifacts/ArtifactManifest.ts";
import {
  ASSET_ROUTE_PREFIX,
  WORKSPACE_RASTER_IMAGE_MAX_BYTES,
  detectWorkspaceRasterMimeType,
  issueAssetUrl,
  resolveAsset,
} from "./AssetAccess.ts";
import {
  activityAuthorizesExternalImagePath,
  messageAuthorizesExternalImagePath,
} from "./ThreadAssetAuthorization.ts";

const configLayer = ServerConfig.ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-asset-access-test-",
});
const testLayer = Layer.mergeAll(
  configLayer,
  WorkspacePaths.layer,
  ProjectFaviconResolver.layer.pipe(
    Layer.provide(WorkspacePaths.layer),
    Layer.provide(T3ProjectFileLoader.layer),
  ),
  ServerSecretStore.layer.pipe(Layer.provide(configLayer)),
).pipe(Layer.provideMerge(NodeServices.layer));

describe("AssetAccess", () => {
  it("detects supported raster signatures without trusting extensions", () => {
    expect(
      detectWorkspaceRasterMimeType(
        new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      ),
    ).toBe("image/png");
    expect(detectWorkspaceRasterMimeType(new Uint8Array([0xff, 0xd8, 0xff]))).toBe("image/jpeg");
    expect(detectWorkspaceRasterMimeType(new TextEncoder().encode("not an image"))).toBeNull();
  });

  it.effect("issues workspace URLs that resolve the entry file and sibling assets", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-asset-workspace-",
      });
      const htmlPath = path.join(root, "report.html");
      const cssPath = path.join(root, "report.css");
      yield* fileSystem.writeFileString(htmlPath, '<link rel="stylesheet" href="report.css">');
      yield* fileSystem.writeFileString(cssPath, "body { color: red; }");
      yield* fileSystem.writeFileString(path.join(root, ".env"), "SECRET=value");
      const canonicalHtmlPath = yield* fileSystem.realPath(htmlPath);
      const canonicalCssPath = yield* fileSystem.realPath(cssPath);

      const result = yield* issueAssetUrl({
        resource: {
          _tag: "workspace-file",
          threadId: ThreadId.make("thread-1"),
          path: htmlPath,
        },
        workspaceRoot: root,
      });
      const suffix = result.relativeUrl.slice(`${ASSET_ROUTE_PREFIX}/`.length);
      const separatorIndex = suffix.indexOf("/");
      const token = suffix.slice(0, separatorIndex);

      expect(yield* resolveAsset(token, "report.html")).toEqual({
        kind: "file",
        path: canonicalHtmlPath,
      });
      expect(yield* resolveAsset(token, "report.css")).toEqual({
        kind: "file",
        path: canonicalCssPath,
      });
      expect(yield* resolveAsset(token, "../secret.txt")).toBeNull();
      expect(yield* resolveAsset(token, ".env")).toBeNull();
      expect(yield* resolveAsset(`${token}tampered`, "report.html")).toBeNull();
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("serves only manifest-listed relative files through one signed artifact revision", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const config = yield* ServerConfig.ServerConfig;
      const artifactId = ThreadArtifactId.make("artifact-signed-relative-bundle");
      const revisionRoot = path.join(config.artifactsDir, artifactId, "revisions", "1");
      const siteRoot = path.join(revisionRoot, "site");
      const indexPath = path.join(siteRoot, "index.html");
      const cssPath = path.join(siteRoot, "styles", "app.css");
      const jsPath = path.join(siteRoot, "scripts", "app.js");
      const sharedPath = path.join(revisionRoot, "shared", "base.css");
      const privatePath = path.join(siteRoot, "private.txt");
      const iconPath = path.join(revisionRoot, "icon.svg");
      yield* fileSystem.makeDirectory(path.dirname(cssPath), { recursive: true });
      yield* fileSystem.makeDirectory(path.dirname(jsPath), { recursive: true });
      yield* fileSystem.makeDirectory(path.dirname(sharedPath), { recursive: true });
      yield* fileSystem.writeFileString(
        indexPath,
        '<link rel="stylesheet" href="styles/app.css"><link rel="stylesheet" href="../shared/base.css"><script src="scripts/app.js"></script>',
      );
      yield* fileSystem.writeFileString(cssPath, "body { color: purple; }");
      yield* fileSystem.writeFileString(jsPath, "document.body.dataset.ready = 'true';");
      yield* fileSystem.writeFileString(sharedPath, "html { color-scheme: light; }");
      yield* fileSystem.writeFileString(privatePath, "must not be served");
      yield* fileSystem.writeFileString(
        iconPath,
        '<svg viewBox="0 0 1 1"><circle cx="0.5" cy="0.5" r="0.5"></circle></svg>',
      );
      yield* fileSystem.writeFileString(
        path.join(revisionRoot, ".manifest.json"),
        encodeArtifactManifest({
          version: 1,
          entryPath: "site/index.html",
          files: [
            { path: "site/index.html", contentType: "text/html", byteLength: 86 },
            { path: "site/styles/app.css", contentType: "text/css", byteLength: 23 },
            {
              path: "site/scripts/app.js",
              contentType: "text/javascript",
              byteLength: 41,
            },
            { path: "shared/base.css", contentType: "text/css", byteLength: 29 },
          ],
        }),
      );

      const result = yield* issueAssetUrl({
        resource: {
          _tag: "artifact-revision",
          threadId: ThreadId.make("thread-signed-relative-bundle"),
          artifactId,
          revision: 1,
          path: "site/index.html",
        },
      });
      expect(result.relativeUrl.startsWith(`${ASSET_ROUTE_PREFIX}/`)).toBe(true);
      expect(result.relativeUrl).not.toContain("localhost");
      const suffix = result.relativeUrl.slice(`${ASSET_ROUTE_PREFIX}/`.length);
      const separatorIndex = suffix.indexOf("/");
      const token = suffix.slice(0, separatorIndex);
      expect(result.relativeUrl.endsWith("/site/index.html")).toBe(true);

      expect(yield* resolveAsset(token, "site/index.html")).toEqual({
        kind: "file",
        path: yield* fileSystem.realPath(indexPath),
        artifact: true,
        contentType: "text/html",
      });
      expect(yield* resolveAsset(token, "site/styles/app.css")).toEqual({
        kind: "file",
        path: yield* fileSystem.realPath(cssPath),
        artifact: true,
        contentType: "text/css",
      });
      expect(yield* resolveAsset(token, "site/scripts/app.js")).toEqual({
        kind: "file",
        path: yield* fileSystem.realPath(jsPath),
        artifact: true,
        contentType: "text/javascript",
      });
      const parentRelativeUrl = new URL(`https://remote.test${result.relativeUrl}`);
      const resolvedParentRelativeUrl = new URL("../shared/base.css", parentRelativeUrl);
      const capabilityPrefix = `${ASSET_ROUTE_PREFIX}/${token}/`;
      const resolvedParentRelativePath = decodeURIComponent(
        resolvedParentRelativeUrl.pathname.slice(capabilityPrefix.length),
      );
      expect(resolvedParentRelativePath).toBe("shared/base.css");
      expect(yield* resolveAsset(token, resolvedParentRelativePath)).toEqual({
        kind: "file",
        path: yield* fileSystem.realPath(sharedPath),
        artifact: true,
        contentType: "text/css",
      });
      expect(yield* resolveAsset(token, "site/private.txt")).toBeNull();
      expect(yield* resolveAsset(token, "../.manifest.json")).toBeNull();
      expect(yield* resolveAsset(`${token}tampered`, "site/index.html")).toBeNull();

      const iconResult = yield* issueAssetUrl({
        resource: {
          _tag: "artifact-icon",
          threadId: ThreadId.make("thread-signed-relative-bundle"),
          artifactId,
          revision: 1,
        },
      });
      const iconSuffix = iconResult.relativeUrl.slice(`${ASSET_ROUTE_PREFIX}/`.length);
      const iconToken = iconSuffix.slice(0, iconSuffix.indexOf("/"));
      expect(yield* resolveAsset(iconToken, "icon.svg")).toEqual({
        kind: "file",
        path: yield* fileSystem.realPath(iconPath),
        artifact: true,
        contentType: "image/svg+xml",
      });
      expect(yield* resolveAsset(iconToken, "index.html")).toBeNull();
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("rejects workspace files outside the authorized root", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-asset-root-",
      });
      const outside = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-asset-outside-",
      });
      const htmlPath = path.join(outside, "report.html");
      yield* fileSystem.writeFileString(htmlPath, "<p>outside</p>");

      const error = yield* issueAssetUrl({
        resource: {
          _tag: "workspace-file",
          threadId: ThreadId.make("thread-1"),
          path: htmlPath,
        },
        workspaceRoot: root,
      }).pipe(Effect.flip);
      expect(error.message).toBe("Workspace file path must be relative to the project root.");
      expect(error).toMatchObject({
        _tag: "AssetWorkspacePathValidationError",
        resource: {
          _tag: "workspace-file",
          threadId: "thread-1",
          path: htmlPath,
        },
      });
      expect(error.cause).toBeInstanceOf(WorkspacePaths.WorkspacePathOutsideRootError);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("preserves non-missing canonical path failures when issuing asset URLs", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-asset-permission-root-",
      });
      const htmlPath = path.join(root, "report.html");
      yield* fileSystem.writeFileString(htmlPath, "<p>report</p>");
      const cause = PlatformError.systemError({
        _tag: "PermissionDenied",
        module: "FileSystem",
        method: "realPath",
        pathOrDescriptor: htmlPath,
      });
      const failingFileSystem = FileSystem.FileSystem.of({
        ...fileSystem,
        realPath: () => Effect.fail(cause),
      });

      const error = yield* issueAssetUrl({
        resource: {
          _tag: "workspace-file",
          threadId: ThreadId.make("thread-1"),
          path: htmlPath,
        },
        workspaceRoot: root,
      }).pipe(Effect.provideService(FileSystem.FileSystem, failingFileSystem), Effect.flip);

      expect(error.message).toBe("Failed to inspect the workspace asset.");
      expect(error).toMatchObject({
        _tag: "AssetWorkspaceAssetInspectionError",
        resource: {
          _tag: "workspace-file",
          threadId: "thread-1",
          path: htmlPath,
        },
      });
      expect(error.cause).toBe(cause);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("issues exact workspace URLs for image previews", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-asset-image-workspace-",
      });
      const assetsDirectory = path.join(root, "assets");
      const imagePath = path.join(assetsDirectory, "icon.png");
      const siblingPath = path.join(assetsDirectory, "other.png");
      yield* fileSystem.makeDirectory(assetsDirectory, { recursive: true });
      const pngSignature = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
      yield* fileSystem.writeFile(imagePath, pngSignature);
      yield* fileSystem.writeFile(siblingPath, pngSignature);
      const canonicalImagePath = yield* fileSystem.realPath(imagePath);

      const result = yield* issueAssetUrl({
        resource: {
          _tag: "workspace-file",
          threadId: ThreadId.make("thread-1"),
          path: imagePath,
        },
        workspaceRoot: root,
      });
      const suffix = result.relativeUrl.slice(`${ASSET_ROUTE_PREFIX}/`.length);
      const separatorIndex = suffix.indexOf("/");
      const token = suffix.slice(0, separatorIndex);

      expect(yield* resolveAsset(token, "icon.png")).toEqual({
        kind: "file",
        path: canonicalImagePath,
      });
      expect(yield* resolveAsset(token, "other.png")).toBeNull();
      expect(yield* resolveAsset(token, "../icon.png")).toBeNull();
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("issues exact capabilities for activity-authorized external raster images", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-asset-external-image-root-",
      });
      const outside = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-asset-external-image-file-",
      });
      const imagePath = path.join(outside, "preview.png");
      const siblingPath = path.join(outside, "other.png");
      const pngSignature = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
      yield* fileSystem.writeFile(imagePath, pngSignature);
      yield* fileSystem.writeFile(siblingPath, pngSignature);
      const canonicalImagePath = yield* fileSystem.realPath(imagePath);

      const result = yield* issueAssetUrl({
        resource: {
          _tag: "workspace-file",
          threadId: ThreadId.make("thread-1"),
          path: imagePath,
          sourceActivityId: EventId.make("activity-image-view"),
        },
        workspaceRoot: root,
        allowExternalExactImage: true,
      });
      const suffix = result.relativeUrl.slice(`${ASSET_ROUTE_PREFIX}/`.length);
      const separatorIndex = suffix.indexOf("/");
      const token = suffix.slice(0, separatorIndex);

      expect(yield* resolveAsset(token, "preview.png")).toEqual({
        kind: "file",
        path: canonicalImagePath,
      });
      expect(yield* resolveAsset(token, "other.png")).toBeNull();

      yield* fileSystem.writeFileString(imagePath, "no longer a png");
      expect(yield* resolveAsset(token, "preview.png")).toBeNull();
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("serves valid image bytes for an exact dynamic Read path under the OS temp root", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const hostPlatform = yield* HostProcessPlatform;
      const workspaceRoot = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-asset-read-workspace-",
      });
      const tempRoot = hostPlatform === "win32" ? NodeOS.tmpdir() : "/tmp";
      const outside = yield* fileSystem.makeTempDirectoryScoped({
        directory: tempRoot,
        prefix: "solla-read-image-",
      });
      const imagePath = path.join(outside, "wood_maps.png");
      const siblingPath = path.join(outside, "private.png");
      const pngBytes = new Uint8Array([
        137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82,
      ]);
      yield* fileSystem.writeFile(imagePath, pngBytes);
      yield* fileSystem.writeFile(siblingPath, pngBytes);

      const sourceActivityId = EventId.make("activity-dynamic-read-temp-image");
      const activity: OrchestrationThreadActivity = {
        id: sourceActivityId,
        tone: "tool",
        kind: "tool.completed",
        summary: "Tool call",
        payload: {
          itemType: "dynamic_tool_call",
          title: "Read File",
          data: {
            kind: "read",
            input: { file_path: imagePath },
          },
        },
        turnId: null,
        createdAt: "2026-07-30T12:00:00.000Z",
      };
      const allowExternalExactImage = activityAuthorizesExternalImagePath(activity, imagePath);
      expect(allowExternalExactImage).toBe(true);

      const result = yield* issueAssetUrl({
        resource: {
          _tag: "workspace-file",
          threadId: ThreadId.make("thread-temp-read"),
          path: imagePath,
          sourceActivityId,
        },
        workspaceRoot,
        allowExternalExactImage,
      });
      const suffix = result.relativeUrl.slice(`${ASSET_ROUTE_PREFIX}/`.length);
      const separatorIndex = suffix.indexOf("/");
      const token = suffix.slice(0, separatorIndex);
      const resolved = yield* resolveAsset(token, "wood_maps.png");
      expect(resolved).not.toBeNull();
      if (!resolved || resolved.kind !== "file") {
        return;
      }
      expect(Array.from(yield* fileSystem.readFile(resolved.path))).toEqual(Array.from(pngBytes));
      expect(yield* resolveAsset(token, "private.png")).toBeNull();

      const sourceMessageId = MessageId.make("assistant-temp-image-link");
      const sourceMessage: OrchestrationMessage = {
        id: sourceMessageId,
        role: "assistant",
        text: `[wood_maps.png](${imagePath})`,
        turnId: null,
        streaming: false,
        createdAt: "2026-07-30T12:00:01.000Z",
        updatedAt: "2026-07-30T12:00:01.000Z",
      };
      const allowLinkedExternalImage = messageAuthorizesExternalImagePath(sourceMessage, imagePath);
      expect(allowLinkedExternalImage).toBe(true);
      const linkedResult = yield* issueAssetUrl({
        resource: {
          _tag: "workspace-file",
          threadId: ThreadId.make("thread-temp-link"),
          path: imagePath,
          sourceMessageId,
        },
        workspaceRoot,
        allowExternalExactImage: allowLinkedExternalImage,
      });
      const linkedSuffix = linkedResult.relativeUrl.slice(`${ASSET_ROUTE_PREFIX}/`.length);
      const linkedSeparatorIndex = linkedSuffix.indexOf("/");
      const linkedToken = linkedSuffix.slice(0, linkedSeparatorIndex);
      expect(yield* resolveAsset(linkedToken, "wood_maps.png")).toEqual(resolved);
      expect(yield* resolveAsset(linkedToken, "private.png")).toBeNull();
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("rejects mismatched and oversized raster workspace assets", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-asset-invalid-image-workspace-",
      });
      const mismatchedPath = path.join(root, "mismatched.png");
      yield* fileSystem.writeFileString(mismatchedPath, "not a png");

      const mismatched = yield* issueAssetUrl({
        resource: {
          _tag: "workspace-file",
          threadId: ThreadId.make("thread-1"),
          path: mismatchedPath,
        },
        workspaceRoot: root,
      }).pipe(Effect.flip);
      expect(mismatched._tag).toBe("AssetPreviewMimeTypeValidationError");

      const oversizedPath = path.join(root, "oversized.png");
      const oversizedBytes = new Uint8Array(WORKSPACE_RASTER_IMAGE_MAX_BYTES + 1);
      oversizedBytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
      yield* fileSystem.writeFile(oversizedPath, oversizedBytes);
      const oversized = yield* issueAssetUrl({
        resource: {
          _tag: "workspace-file",
          threadId: ThreadId.make("thread-1"),
          path: oversizedPath,
        },
        workspaceRoot: root,
      }).pipe(Effect.flip);
      expect(oversized).toMatchObject({
        _tag: "AssetPreviewFileTooLargeError",
        byteLength: WORKSPACE_RASTER_IMAGE_MAX_BYTES + 1,
        maxByteLength: WORKSPACE_RASTER_IMAGE_MAX_BYTES,
      });
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("issues exact attachment capabilities by attachment id", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const attachmentId = "thread-1-00000000-0000-4000-8000-000000000001";
      const attachmentPath = path.join(config.attachmentsDir, `${attachmentId}.png`);
      yield* fileSystem.makeDirectory(config.attachmentsDir, { recursive: true });
      yield* fileSystem.writeFile(attachmentPath, new Uint8Array([1, 2, 3]));

      const result = yield* issueAssetUrl({
        resource: { _tag: "attachment", attachmentId },
      });
      const suffix = result.relativeUrl.slice(`${ASSET_ROUTE_PREFIX}/`.length);
      const separatorIndex = suffix.indexOf("/");
      const token = suffix.slice(0, separatorIndex);

      expect(yield* resolveAsset(token, "ignored.png")).toEqual({
        kind: "file",
        path: attachmentPath,
      });
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("serves legacy HEIC attachments as browser-compatible JPEG bytes", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const attachmentId = "thread-1-00000000-0000-4000-8000-000000000002";
      const attachmentPath = path.join(config.attachmentsDir, `${attachmentId}.heic`);
      yield* fileSystem.makeDirectory(config.attachmentsDir, { recursive: true });
      yield* fileSystem.writeFile(attachmentPath, Buffer.from(HEIC_FIXTURE_BASE64, "base64"));

      const result = yield* issueAssetUrl({
        resource: { _tag: "attachment", attachmentId },
      });
      const suffix = result.relativeUrl.slice(`${ASSET_ROUTE_PREFIX}/`.length);
      const separatorIndex = suffix.indexOf("/");
      const token = suffix.slice(0, separatorIndex);
      const resolved = yield* resolveAsset(token, "ignored.heic");

      expect(resolved?.kind).toBe("bytes");
      if (resolved?.kind !== "bytes") return;
      expect(resolved.contentType).toBe("image/jpeg");
      expect(Array.from(resolved.bytes.slice(0, 3))).toEqual([0xff, 0xd8, 0xff]);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("issues project favicon capabilities with a signed fallback", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-asset-favicon-",
      });
      const faviconPath = path.join(root, "favicon.svg");
      const initialFavicon = "<svg>a</svg>";
      const updatedFavicon = "<svg>b</svg>";
      expect(updatedFavicon).toHaveLength(initialFavicon.length);
      yield* fileSystem.writeFileString(faviconPath, initialFavicon);
      const canonicalFaviconPath = yield* fileSystem.realPath(faviconPath);

      const faviconResult = yield* issueAssetUrl({
        resource: { _tag: "project-favicon", cwd: root },
      });
      expect(faviconResult.relativeUrl).toMatch(/\/v[0-9a-f]{64}-favicon\.svg$/);
      expect(
        yield* issueAssetUrl({
          resource: { _tag: "project-favicon", cwd: root },
        }),
      ).toEqual(faviconResult);
      const faviconSuffix = faviconResult.relativeUrl.slice(`${ASSET_ROUTE_PREFIX}/`.length);
      const faviconSeparatorIndex = faviconSuffix.indexOf("/");
      expect(
        yield* resolveAsset(
          faviconSuffix.slice(0, faviconSeparatorIndex),
          faviconSuffix.slice(faviconSeparatorIndex + 1),
        ),
      ).toEqual({ kind: "file", path: canonicalFaviconPath });

      yield* fileSystem.writeFileString(faviconPath, updatedFavicon);
      const updatedFaviconResult = yield* issueAssetUrl({
        resource: { _tag: "project-favicon", cwd: root },
      });
      expect(
        updatedFaviconResult.relativeUrl.slice(updatedFaviconResult.relativeUrl.lastIndexOf("/")),
      ).not.toBe(faviconResult.relativeUrl.slice(faviconResult.relativeUrl.lastIndexOf("/")));

      yield* fileSystem.remove(faviconPath);
      const fallbackResult = yield* issueAssetUrl({
        resource: { _tag: "project-favicon", cwd: root },
      });
      expect(fallbackResult.relativeUrl.endsWith(`/${PROJECT_FAVICON_FALLBACK_MARKER}`)).toBe(true);
      const fallbackSuffix = fallbackResult.relativeUrl.slice(`${ASSET_ROUTE_PREFIX}/`.length);
      const fallbackSeparatorIndex = fallbackSuffix.indexOf("/");
      expect(
        yield* resolveAsset(
          fallbackSuffix.slice(0, fallbackSeparatorIndex),
          fallbackSuffix.slice(fallbackSeparatorIndex + 1),
        ),
      ).toBeNull();
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("buckets project favicon expiry after content hashing", () =>
    Effect.gen(function* () {
      const crypto = yield* Crypto.Crypto;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-asset-favicon-expiry-",
      });
      yield* fileSystem.writeFileString(path.join(root, "favicon.svg"), "<svg />");

      const bucketMs = 30 * 60 * 1000;
      yield* TestClock.setTime(bucketMs - 1);
      const crossingCrypto = Crypto.make({
        randomBytes: (size) => new Uint8Array(size),
        digest: (algorithm, data) =>
          TestClock.adjust("2 millis").pipe(Effect.andThen(crypto.digest(algorithm, data))),
      });
      const result = yield* issueAssetUrl({
        resource: { _tag: "project-favicon", cwd: root },
      }).pipe(Effect.provideService(Crypto.Crypto, crossingCrypto));

      expect(result.expiresAt).toBe(3 * bucketMs);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("preserves structured project favicon resolution causes", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-asset-favicon-error-",
      });
      const platformCause = PlatformError.systemError({
        _tag: "PermissionDenied",
        module: "FileSystem",
        method: "stat",
      });
      const resolutionCause = new ProjectFaviconResolver.ProjectFaviconResolutionError({
        operation: "stat-candidate",
        workspaceRoot: root,
        relativePath: "favicon.svg",
        cause: platformCause,
      });
      const resolver = ProjectFaviconResolver.ProjectFaviconResolver.of({
        resolvePath: () => Effect.fail(resolutionCause),
      });

      const error = yield* issueAssetUrl({
        resource: { _tag: "project-favicon", cwd: root },
      }).pipe(
        Effect.provideService(ProjectFaviconResolver.ProjectFaviconResolver, resolver),
        Effect.flip,
      );

      expect(error.message).toBe("Failed to resolve project favicon.");
      expect(error._tag).toBe("AssetProjectFaviconResolutionError");
      expect(error.cause).toBe(resolutionCause);
    }).pipe(Effect.provide(testLayer)),
  );
});
