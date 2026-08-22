import {
  ThreadArtifactId,
  ThreadArtifactInvalidInputError,
  ThreadArtifactStorageError,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { issueArtifactAssetUrl } from "../../../assets/AssetAccess.ts";
import { ThreadArtifactService } from "../../../artifacts/ThreadArtifactService.ts";
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
        if (hasText === hasBase64) {
          return new ThreadArtifactInvalidInputError({
            field: `files.${file.path}`,
            reason: "must provide exactly one of text or dataBase64",
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
