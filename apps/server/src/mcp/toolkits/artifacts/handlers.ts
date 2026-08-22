import {
  ThreadArtifactId,
  ThreadArtifactInvalidInputError,
  ThreadArtifactStorageError,
} from "@t3tools/contracts";
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as Effect from "effect/Effect";

import { issueArtifactAssetUrl } from "../../../assets/AssetAccess.ts";
import { ThreadArtifactService } from "../../../artifacts/ThreadArtifactService.ts";
import {
  describeLocalPathRejection,
  isInside,
  MAX_LOCAL_FILE_BYTES,
  resolveArtifactLocalPath,
} from "./localFiles.ts";
import {
  describeMissingAssetReferences,
  findMissingAssetReferences,
  normalizeArtifactPath,
} from "./assetReferences.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { ThreadArtifactToolkit } from "./tools.ts";
import type { ThreadArtifactToolInput } from "./types.ts";

const requireField = <K extends "artifactId" | "key" | "title" | "kind" | "entryPath" | "files">(
  input: ThreadArtifactToolInput,
  field: K,
): Effect.Effect<NonNullable<ThreadArtifactToolInput[K]>, ThreadArtifactInvalidInputError> => {
  const value = input[field];
  return value === undefined
    ? Effect.fail(
        new ThreadArtifactInvalidInputError({
          field,
          reason: `is required for ${input.action}`,
        }),
      )
    : Effect.succeed(value as NonNullable<ThreadArtifactToolInput[K]>);
};

function decodeBase64(value: string): Uint8Array | null {
  const normalized = value.replaceAll(/\s/gu, "");
  if (
    normalized.length === 0 ||
    normalized.length % 4 === 1 ||
    !/^[A-Za-z0-9+/]*={0,2}$/u.test(normalized)
  ) {
    return null;
  }
  const bytes = Buffer.from(normalized, "base64");
  const canonical = bytes.toString("base64").replaceAll("=", "");
  return canonical === normalized.replaceAll("=", "") ? bytes : null;
}

export const handleThreadArtifact = Effect.fn("ThreadArtifact.handle")(function* (
  input: ThreadArtifactToolInput,
) {
  const invocation = yield* McpInvocationContext.McpInvocationContext;
  if (!invocation.capabilities.has("artifacts")) {
    return yield* new ThreadArtifactInvalidInputError({
      field: "capability",
      reason: "this provider session cannot manage artifacts",
    });
  }
  const service = yield* ThreadArtifactService;

  switch (input.action) {
    case "list": {
      const list = yield* service.list({
        threadId: invocation.threadId,
        includeArchived: input.includeArchived,
      });
      return { action: input.action, status: "Artifacts loaded.", list };
    }
    case "get": {
      const artifactId = yield* requireField(input, "artifactId");
      const detail = yield* service.get({ threadId: invocation.threadId, artifactId });
      const urls = yield* issueDetailUrls(invocation, detail);
      return { action: input.action, status: "Artifact loaded.", detail, ...urls };
    }
    case "publish": {
      const [key, title, kind, entryPath, files] = yield* Effect.all([
        requireField(input, "key"),
        requireField(input, "title"),
        requireField(input, "kind"),
        requireField(input, "entryPath"),
        requireField(input, "files"),
      ]);
      const decodedFiles = yield* Effect.forEach(files, (file) => {
        const hasText = file.text !== undefined;
        const hasBase64 = file.dataBase64 !== undefined;
        const hasLocalPath = file.localPath !== undefined;
        const sourceCount = [hasText, hasBase64, hasLocalPath].filter(Boolean).length;
        if (sourceCount !== 1) {
          return new ThreadArtifactInvalidInputError({
            field: `files.${file.path}`,
            reason: "must provide exactly one of text, dataBase64 or localPath",
          });
        }
        if (file.localPath !== undefined) {
          return readLocalArtifactFile({
            path: file.path,
            contentType: file.contentType,
            localPath: file.localPath,
            localDir: input.localDir,
          });
        }
        if (file.text !== undefined) {
          return Effect.succeed({
            path: file.path,
            contentType: file.contentType,
            bytes: new TextEncoder().encode(file.text),
          });
        }
        const bytes = decodeBase64(file.dataBase64 ?? "");
        return bytes
          ? Effect.succeed({ path: file.path, contentType: file.contentType, bytes })
          : new ThreadArtifactInvalidInputError({
              field: `files.${file.path}.dataBase64`,
              reason: "is not valid base64",
            });
      });
      // A revision is served from exactly these files, so a path pointing
      // outside them is a broken page rather than a partial one. Better to
      // refuse here, while whoever is publishing still has the asset, than to
      // hand back a URL that renders empty frames.
      const missing = findMissingAssetReferences(decodedFiles);
      if (missing.length > 0) {
        return yield* new ThreadArtifactInvalidInputError({
          field: "files",
          reason: describeMissingAssetReferences(missing),
        });
      }
      if (
        !decodedFiles.some(
          (file) => normalizeArtifactPath(file.path) === normalizeArtifactPath(entryPath),
        )
      ) {
        return yield* new ThreadArtifactInvalidInputError({
          field: "entryPath",
          reason: `'${entryPath}' is not among the published files`,
        });
      }
      const detail = yield* service.publish({
        threadId: invocation.threadId,
        ...(input.artifactId === undefined ? {} : { artifactId: input.artifactId }),
        key,
        title,
        ...(input.description === undefined ? {} : { description: input.description }),
        kind,
        entryPath,
        files: decodedFiles,
        ...(input.iconSvg === undefined ? {} : { iconSvg: input.iconSvg }),
      });
      const urls = yield* issueDetailUrls(invocation, detail);
      return {
        action: input.action,
        status: `Artifact revision ${detail.revision.revision} published.`,
        detail,
        ...urls,
      };
    }
    case "archive":
    case "restore": {
      const artifactId = ThreadArtifactId.make(yield* requireField(input, "artifactId"));
      const detail = yield* service.setArchived({
        threadId: invocation.threadId,
        artifactId,
        archived: input.action === "archive",
      });
      const urls = yield* issueDetailUrls(invocation, detail);
      return {
        action: input.action,
        status: input.action === "archive" ? "Artifact archived." : "Artifact restored.",
        detail,
        ...urls,
      };
    }
  }
});

const issueDetailUrls = Effect.fn("ThreadArtifact.issueDetailUrls")(function* (
  invocation: McpInvocationContext.McpInvocationScope,
  detail: {
    readonly artifact: { readonly artifactId: ThreadArtifactId };
    readonly revision: { readonly revision: number; readonly entryPath: string };
  },
) {
  const resource = {
    threadId: invocation.threadId,
    artifactId: detail.artifact.artifactId,
    revision: detail.revision.revision,
  } as const;
  const [content, icon] = yield* Effect.all([
    issueArtifactAssetUrl({
      _tag: "artifact-revision",
      ...resource,
      path: detail.revision.entryPath,
    }),
    issueArtifactAssetUrl({ _tag: "artifact-icon", ...resource }),
  ]).pipe(
    Effect.mapError(
      (cause) =>
        new ThreadArtifactStorageError({
          operation: "issuing signed artifact URLs",
          cause,
        }),
    ),
  );
  const openPath = `/${encodeURIComponent(invocation.environmentId)}/${encodeURIComponent(invocation.threadId)}?artifact=${encodeURIComponent(detail.artifact.artifactId)}`;
  const resourcePath = detail.revision.entryPath
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return {
    contentUrl: content.relativeUrl,
    iconUrl: icon.relativeUrl,
    openPath,
    deepLink: openPath,
    resourceUri: `t3-artifact://${encodeURIComponent(invocation.environmentId)}/${encodeURIComponent(invocation.threadId)}/${encodeURIComponent(detail.artifact.artifactId)}/revisions/${detail.revision.revision}/${resourcePath}`,
    expiresAt: Math.min(content.expiresAt, icon.expiresAt),
  };
});

const handlers = {
  thread_artifact: handleThreadArtifact,
} satisfies Parameters<typeof ThreadArtifactToolkit.toLayer>[0];

export const ThreadArtifactToolkitHandlersLive = ThreadArtifactToolkit.toLayer(handlers);

/**
 * Reads one bundle file from disk instead of from the tool call.
 *
 * Confinement is checked twice on purpose. `resolveArtifactLocalPath` rejects
 * the path as written, and the realpath check below rejects it as the
 * filesystem actually resolves it — a symlink inside the directory pointing
 * anywhere else passes the first and fails the second.
 */
const readLocalArtifactFile = Effect.fn("ThreadArtifact.readLocalFile")(function* (input: {
  readonly path: string;
  readonly contentType: string;
  readonly localPath: string;
  readonly localDir: string | undefined;
}) {
  const resolution = resolveArtifactLocalPath({
    localPath: input.localPath,
    localDir: input.localDir,
  });
  if (!resolution.ok) {
    return yield* new ThreadArtifactInvalidInputError({
      field: `files.${input.path}.localPath`,
      reason: describeLocalPathRejection(input.localPath, resolution.rejection),
    });
  }

  const real = yield* Effect.promise(() =>
    NodeFSP.realpath(resolution.absolutePath).then(
      (value): string | null => value,
      () => null,
    ),
  );
  if (real === null) {
    return yield* new ThreadArtifactInvalidInputError({
      field: `files.${input.path}.localPath`,
      reason: `'${input.localPath}' does not exist or cannot be read`,
    });
  }
  // The link target, not the link, is what would actually be published.
  if (!isInside(input.localDir ?? "", real)) {
    return yield* new ThreadArtifactInvalidInputError({
      field: `files.${input.path}.localPath`,
      reason: `'${input.localPath}' resolves through a link to '${real}', outside localDir`,
    });
  }

  const stat = yield* Effect.promise(() =>
    NodeFSP.stat(real).then(
      (value) => value,
      () => null,
    ),
  );
  if (stat === null || !stat.isFile()) {
    return yield* new ThreadArtifactInvalidInputError({
      field: `files.${input.path}.localPath`,
      reason: `'${input.localPath}' is not a regular file`,
    });
  }
  if (stat.size > MAX_LOCAL_FILE_BYTES) {
    return yield* new ThreadArtifactInvalidInputError({
      field: `files.${input.path}.localPath`,
      reason: `'${input.localPath}' is ${stat.size} bytes, over the ${MAX_LOCAL_FILE_BYTES} byte limit`,
    });
  }

  const bytes = yield* Effect.promise(() =>
    NodeFSP.readFile(real).then(
      (value): Buffer | null => value,
      () => null,
    ),
  );
  if (bytes === null) {
    return yield* new ThreadArtifactInvalidInputError({
      field: `files.${input.path}.localPath`,
      reason: `'${input.localPath}' could not be read`,
    });
  }
  return { path: input.path, contentType: input.contentType, bytes: new Uint8Array(bytes) };
});
