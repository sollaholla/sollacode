import * as NodeCrypto from "node:crypto";

import {
  type ThreadArtifact,
  type ThreadArtifactDeleteResult,
  type ThreadArtifactDetail,
  type ThreadArtifactError,
  ThreadArtifactId,
  ThreadArtifactKey,
  type ThreadArtifactKind,
  type ThreadArtifactListInput,
  type ThreadArtifactListResult,
  type ThreadArtifactStreamItem,
  ThreadArtifactInvalidInputError,
  ThreadArtifactNotFoundError,
  ThreadArtifactQuotaExceededError,
  type ThreadArtifactRevision,
  ThreadArtifactStorageError,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import { SaxesParser } from "saxes";

import * as ServerConfig from "../config.ts";
import {
  deriveArtifactMimeType,
  encodeArtifactManifest,
  type ArtifactManifest,
} from "./ArtifactManifest.ts";

export const THREAD_ARTIFACT_REVISION_MAX_BYTES = 20 * 1024 * 1024;
export const THREAD_ARTIFACT_NORMAL_FILE_MAX_BYTES = 5 * 1024 * 1024;
export const THREAD_ARTIFACT_LARGE_FILE_MAX_BYTES = 20 * 1024 * 1024;
export const THREAD_ARTIFACT_MAX_FILES = 256;
export const THREAD_ARTIFACT_MAX_REVISIONS = 20;
export const THREAD_ARTIFACT_THREAD_MAX_BYTES = 200 * 1024 * 1024;
export const THREAD_ARTIFACT_ICON_MAX_BYTES = 16 * 1024;
export const THREAD_ARTIFACT_ICON_MAX_NODES = 64;

const SAFE_WEB_EXTENSIONS = new Set([
  ".avif",
  ".css",
  ".gif",
  ".html",
  ".htm",
  ".ico",
  ".jpeg",
  ".jpg",
  ".js",
  ".json",
  ".png",
  ".svg",
  ".ttf",
  ".webp",
  ".woff",
  ".woff2",
]);
const LARGE_FILE_CONTENT_TYPES = new Set([
  "application/pdf",
  "image/avif",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
]);
const SAFE_SVG_ELEMENTS = new Set([
  "svg",
  "g",
  "path",
  "circle",
  "ellipse",
  "line",
  "polyline",
  "polygon",
  "rect",
  "title",
  "desc",
]);
const SAFE_SVG_ATTRIBUTES = new Set([
  "aria-hidden",
  "cx",
  "cy",
  "d",
  "fill",
  "fill-opacity",
  "fill-rule",
  "height",
  "id",
  "opacity",
  "points",
  "preserveAspectRatio",
  "r",
  "role",
  "rx",
  "ry",
  "stroke",
  "stroke-linecap",
  "stroke-linejoin",
  "stroke-opacity",
  "stroke-width",
  "transform",
  "viewBox",
  "width",
  "x",
  "x1",
  "x2",
  "y",
  "y1",
  "y2",
]);

const escapeXml = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");

/** Parse and reserialize only the tiny SVG subset used by artifact icons. */
export function sanitizeArtifactIconSvg(svg: string): string | null {
  if (Buffer.byteLength(svg, "utf8") > THREAD_ARTIFACT_ICON_MAX_BYTES) return null;
  const output: string[] = [];
  const stack: string[] = [];
  let nodes = 0;
  let rootSeen = false;
  let invalid = false;
  try {
    const parser = new SaxesParser({ xmlns: false });
    parser.on("opentag", (tag) => {
      nodes += 1;
      if (nodes > THREAD_ARTIFACT_ICON_MAX_NODES || !SAFE_SVG_ELEMENTS.has(tag.name)) {
        invalid = true;
        return;
      }
      if (!rootSeen) {
        rootSeen = true;
        if (tag.name !== "svg") invalid = true;
      }
      const attributes = Object.entries(tag.attributes)
        .filter(([name, value]) => {
          if (!SAFE_SVG_ATTRIBUTES.has(name)) return false;
          const normalized = String(value).toLowerCase();
          return !normalized.includes("url(") && !normalized.includes("javascript:");
        })
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([name, value]) => ` ${name}="${escapeXml(String(value))}"`)
        .join("");
      output.push(
        tag.name === "svg"
          ? `<svg xmlns="http://www.w3.org/2000/svg"${attributes}>`
          : `<${tag.name}${attributes}>`,
      );
      stack.push(tag.name);
    });
    parser.on("text", (text) => {
      if (stack.at(-1) === "title" || stack.at(-1) === "desc") {
        output.push(escapeXml(text.slice(0, 256)));
      } else if (text.trim().length > 0) {
        invalid = true;
      }
    });
    parser.on("closetag", (tag) => {
      const name = typeof tag === "string" ? tag : tag.name;
      if (stack.pop() !== name) invalid = true;
      output.push(`</${name}>`);
    });
    parser.on("doctype", () => {
      invalid = true;
    });
    parser.write(svg).close();
  } catch {
    return null;
  }
  if (invalid || !rootSeen || stack.length !== 0) return null;
  return output.join("");
}

function generatedIconSvg(kind: ThreadArtifactKind, key: string): string {
  const colors: Record<ThreadArtifactKind, string> = {
    structured: "#7c3aed",
    markdown: "#2563eb",
    image: "#db2777",
    pdf: "#dc2626",
    web: "#059669",
  };
  const seed = NodeCrypto.createHash("sha256").update(key).digest();
  const accentHue = ((seed[0] ?? 0) * 360) / 256;
  const accentX = 18 + ((seed[1] ?? 0) % 29);
  const accentY = 18 + ((seed[2] ?? 0) % 29);
  const label =
    key
      .trim()
      .match(/[\p{L}\p{N}]/u)?.[0]
      ?.toUpperCase() ?? "A";
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" role="img"><rect width="64" height="64" rx="14" fill="${colors[kind]}"></rect><circle cx="${accentX}" cy="${accentY}" r="12" fill="hsl(${accentHue} 80% 72%)" opacity="0.7"></circle><path d="M18 46L29 18H35L46 46H39L36.5 39H27.5L25 46H18ZM29.5 33H34.5L32 25L29.5 33Z" fill="#fff"></path><title>${escapeXml(label)} ${escapeXml(kind)} artifact</title></svg>`;
}

export interface ThreadArtifactPublishFile {
  readonly path: string;
  readonly contentType: string;
  readonly bytes: Uint8Array;
}

export interface ThreadArtifactPublishInput {
  readonly threadId: ThreadId;
  readonly artifactId?: ThreadArtifactId;
  readonly key: ThreadArtifactKey;
  readonly title: string;
  readonly description?: string | null;
  readonly kind: ThreadArtifactKind;
  readonly entryPath: string;
  readonly files: ReadonlyArray<ThreadArtifactPublishFile>;
  readonly iconSvg?: string;
}

export interface ThreadArtifactArchiveInput {
  readonly threadId: ThreadId;
  readonly artifactId: ThreadArtifactId;
  readonly archived: boolean;
}

export interface ThreadArtifactCleanupResult {
  readonly artifactCount: number;
  readonly revisionCount: number;
}

export interface ThreadArtifactServiceShape {
  readonly list: (
    input: ThreadArtifactListInput,
  ) => Effect.Effect<ThreadArtifactListResult, ThreadArtifactError>;
  readonly get: (input: {
    readonly threadId: ThreadId;
    readonly artifactId: ThreadArtifactId;
  }) => Effect.Effect<ThreadArtifactDetail, ThreadArtifactError>;
  readonly publish: (
    input: ThreadArtifactPublishInput,
  ) => Effect.Effect<ThreadArtifactDetail, ThreadArtifactError>;
  readonly setArchived: (
    input: ThreadArtifactArchiveInput,
  ) => Effect.Effect<ThreadArtifactDetail, ThreadArtifactError>;
  /** Irreversibly removes one artifact: every revision's bytes and rows. */
  readonly deleteArtifact: (input: {
    readonly threadId: ThreadId;
    readonly artifactId: ThreadArtifactId;
  }) => Effect.Effect<ThreadArtifactDeleteResult, ThreadArtifactError>;
  readonly subscribe: (
    input: ThreadArtifactListInput,
  ) => Stream.Stream<ThreadArtifactStreamItem, ThreadArtifactError>;
  /** Internal irreversible cleanup, used only after the owning thread is deleted. */
  readonly cleanupDeletedThread: (
    threadId: ThreadId,
  ) => Effect.Effect<ThreadArtifactCleanupResult, ThreadArtifactStorageError>;
}

export class ThreadArtifactService extends Context.Service<
  ThreadArtifactService,
  ThreadArtifactServiceShape
>()("t3/artifacts/ThreadArtifactService") {}

const ArtifactLookup = Schema.Struct({
  threadId: Schema.String,
  artifactId: Schema.String,
});
const ThreadLookup = Schema.Struct({ threadId: Schema.String, includeArchived: Schema.Boolean });
const ArtifactOnlyLookup = Schema.Struct({ artifactId: Schema.String });
const ArtifactKeyLookup = Schema.Struct({ threadId: Schema.String, key: Schema.String });
const AggregateRow = Schema.Struct({ value: Schema.Number });
const decodeStructuredJson = Schema.decodeUnknownOption(Schema.UnknownFromJsonString);
const ArtifactRow = Schema.Struct({
  artifactId: ThreadArtifactId,
  threadId: Schema.String,
  key: ThreadArtifactKey,
  title: Schema.String,
  description: Schema.NullOr(Schema.String),
  kind: Schema.Literals(["structured", "markdown", "image", "pdf", "web"]),
  currentRevision: Schema.Int,
  archivedAt: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  updatedAt: Schema.String,
});

const mapStorage = (operation: string) => (cause: unknown) =>
  new ThreadArtifactStorageError({ operation, cause });

function safeRelativePath(pathService: Path.Path, value: string): string | null {
  const normalized = value.trim().replaceAll("\\", "/");
  if (
    normalized.length === 0 ||
    normalized.length > 512 ||
    normalized.includes("\0") ||
    normalized.startsWith("/") ||
    pathService.isAbsolute(normalized) ||
    normalized
      .split("/")
      .some(
        (segment) =>
          segment === "" || segment === "." || segment === ".." || segment.startsWith("."),
      )
  ) {
    return null;
  }
  return normalized;
}

function validateClassicWebFile(file: ThreadArtifactPublishFile): boolean {
  if (!file.path.toLowerCase().endsWith(".html") && !file.path.toLowerCase().endsWith(".htm")) {
    if (!file.path.toLowerCase().endsWith(".js")) return true;
    const source = new TextDecoder().decode(file.bytes);
    return !/(?:^|[;\n}]\s*)(?:import\s*(?:\(|["'{*])|export\s+(?:default|const|function|class|\{))/mu.test(
      source,
    );
  }
  const html = new TextDecoder().decode(file.bytes);
  return (
    !/<script\b[^>]*\btype\s*=\s*["']?module\b/iu.test(html) &&
    !/<base\b/iu.test(html) &&
    !/<meta\b[^>]*http-equiv\s*=\s*["']?refresh/iu.test(html)
  );
}

function decodeUtf8(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

function validateKindShape(
  kind: ThreadArtifactKind,
  files: ReadonlyArray<ThreadArtifactPublishFile>,
  entryPath: string,
): string | null {
  const entry = files.find((file) => file.path === entryPath);
  if (!entry) return "entryPath must name one published file";
  switch (kind) {
    case "structured": {
      const json = decodeUtf8(entry.bytes);
      return files.length === 1 &&
        entry.contentType === "application/json" &&
        json !== null &&
        Option.isSome(decodeStructuredJson(json))
        ? null
        : "structured artifacts require one valid UTF-8 JSON file";
    }
    case "markdown":
      return files.length === 1 && entry.contentType === "text/markdown"
        ? null
        : "markdown artifacts require one Markdown file";
    case "image":
      return files.length === 1 &&
        entry.contentType.startsWith("image/") &&
        entry.contentType !== "image/svg+xml"
        ? null
        : "image artifacts require one validated raster image";
    case "pdf":
      return files.length === 1 && entry.contentType === "application/pdf"
        ? null
        : "PDF artifacts require one validated PDF file";
    case "web":
      return /[.]html?$/iu.test(entryPath) && entry.contentType === "text/html"
        ? null
        : "web artifacts must enter through an HTML file";
  }
}

const makeThreadArtifactService = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const fileSystem = yield* FileSystem.FileSystem;
  const pathService = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const changes = yield* PubSub.unbounded<ThreadId>();

  const threadExists = SqlSchema.findOne({
    Request: Schema.Struct({ threadId: Schema.String }),
    Result: AggregateRow,
    execute: ({ threadId }) => sql`
      SELECT COUNT(*) AS value
      FROM projection_threads
      WHERE thread_id = ${threadId} AND deleted_at IS NULL
    `,
  });

  const getArtifactRow = SqlSchema.findOneOption({
    Request: ArtifactLookup,
    Result: ArtifactRow,
    execute: ({ threadId, artifactId }) => sql`
      SELECT artifact_id AS "artifactId", thread_id AS "threadId", artifact_key AS "key",
             title, description, kind,
             current_revision AS "currentRevision", archived_at AS "archivedAt",
             created_at AS "createdAt", updated_at AS "updatedAt"
      FROM thread_artifacts
      WHERE thread_id = ${threadId} AND artifact_id = ${artifactId}
    `,
  });

  const getArtifactRowByKey = SqlSchema.findOneOption({
    Request: ArtifactKeyLookup,
    Result: ArtifactRow,
    execute: ({ threadId, key }) => sql`
      SELECT artifact_id AS "artifactId", thread_id AS "threadId", artifact_key AS "key",
             title, description, kind, current_revision AS "currentRevision",
             archived_at AS "archivedAt", created_at AS "createdAt", updated_at AS "updatedAt"
      FROM thread_artifacts
      WHERE thread_id = ${threadId} AND artifact_key = ${key}
    `,
  });

  const listArtifactRows = SqlSchema.findAll({
    Request: ThreadLookup,
    Result: ArtifactRow,
    execute: ({ threadId, includeArchived }) => sql`
      SELECT artifact_id AS "artifactId", thread_id AS "threadId", artifact_key AS "key",
             title, description, kind,
             current_revision AS "currentRevision", archived_at AS "archivedAt",
             created_at AS "createdAt", updated_at AS "updatedAt"
      FROM thread_artifacts
      WHERE thread_id = ${threadId}
        AND (${includeArchived ? 1 : 0} = 1 OR archived_at IS NULL)
      ORDER BY updated_at DESC, artifact_id ASC
    `,
  });

  const listRevisionRows = SqlSchema.findAll({
    Request: ArtifactOnlyLookup,
    Result: Schema.Struct({
      artifactId: ThreadArtifactId,
      revision: Schema.Int,
      entryPath: Schema.String,
      contentType: Schema.String,
      byteLength: Schema.Int,
      fileCount: Schema.Int,
      iconSource: Schema.Literals(["provided", "generated"]),
      createdAt: Schema.String,
    }),
    execute: ({ artifactId }) => sql`
      SELECT artifact_id AS "artifactId", revision, entry_path AS "entryPath",
             content_type AS "contentType", byte_length AS "byteLength",
             file_count AS "fileCount", icon_source AS "iconSource", created_at AS "createdAt"
      FROM thread_artifact_revisions
      WHERE artifact_id = ${artifactId}
      ORDER BY revision DESC
    `,
  });

  const threadBytes = SqlSchema.findOne({
    Request: Schema.Struct({ threadId: Schema.String }),
    Result: AggregateRow,
    execute: ({ threadId }) => sql`
      SELECT COALESCE(SUM(r.byte_length), 0) AS value
      FROM thread_artifact_revisions r
      INNER JOIN thread_artifacts a ON a.artifact_id = r.artifact_id
      WHERE a.thread_id = ${threadId}
    `,
  });

  const toArtifact = (row: typeof ArtifactRow.Type): ThreadArtifact => ({
    ...row,
    threadId: inputThreadId(row.threadId),
  });
  function inputThreadId(value: string): ThreadId {
    return value as ThreadId;
  }

  const toSummary = (artifact: ThreadArtifact, revision: ThreadArtifactRevision) => ({
    artifact,
    revision,
    entryResource: {
      _tag: "artifact-revision" as const,
      threadId: artifact.threadId,
      artifactId: artifact.artifactId,
      revision: revision.revision,
      path: revision.entryPath,
    },
    iconResource: {
      _tag: "artifact-icon" as const,
      threadId: artifact.threadId,
      artifactId: artifact.artifactId,
      revision: revision.revision,
    },
  });

  const requireLiveThread = Effect.fn("ThreadArtifactService.requireLiveThread")(function* (
    threadId: ThreadId,
  ) {
    const exists = yield* threadExists({ threadId }).pipe(
      Effect.mapError(mapStorage("checking the owning thread")),
    );
    if (exists.value === 0) {
      return yield* new ThreadArtifactNotFoundError({ threadId });
    }
  });

  const get = Effect.fn("ThreadArtifactService.get")(function* (input: {
    readonly threadId: ThreadId;
    readonly artifactId: ThreadArtifactId;
  }) {
    yield* requireLiveThread(input.threadId);
    const artifactRow = yield* getArtifactRow(input).pipe(
      Effect.mapError(mapStorage("reading metadata")),
    );
    if (Option.isNone(artifactRow)) {
      return yield* new ThreadArtifactNotFoundError(input);
    }
    const revisions = yield* listRevisionRows({ artifactId: input.artifactId }).pipe(
      Effect.mapError(mapStorage("reading revisions")),
    );
    const currentRevision = revisions.find(
      (revision) => revision.revision === artifactRow.value.currentRevision,
    );
    if (!currentRevision) {
      return yield* new ThreadArtifactStorageError({
        operation: "resolving the current revision",
        cause: new Error("Current artifact revision metadata is missing."),
      });
    }
    const artifact = toArtifact(artifactRow.value);
    return {
      ...toSummary(artifact, currentRevision as ThreadArtifactRevision),
      revision: currentRevision as ThreadArtifactRevision,
      revisions: revisions as ReadonlyArray<ThreadArtifactRevision>,
    } satisfies ThreadArtifactDetail;
  });

  const list = Effect.fn("ThreadArtifactService.list")(function* (input: ThreadArtifactListInput) {
    yield* requireLiveThread(input.threadId);
    const rows = yield* listArtifactRows({
      threadId: input.threadId,
      includeArchived: input.includeArchived === true,
    }).pipe(Effect.mapError(mapStorage("listing artifacts")));
    const artifacts = yield* Effect.forEach(rows, (row) =>
      listRevisionRows({ artifactId: row.artifactId }).pipe(
        Effect.mapError(mapStorage("listing current revisions")),
        Effect.flatMap((revisions) => {
          const revision = revisions.find((entry) => entry.revision === row.currentRevision);
          return revision
            ? Effect.succeed(toSummary(toArtifact(row), revision as ThreadArtifactRevision))
            : new ThreadArtifactStorageError({
                operation: "resolving a current revision",
                cause: new Error(`Revision ${row.currentRevision} is missing.`),
              });
        }),
      ),
    );
    return { threadId: input.threadId, artifacts } satisfies ThreadArtifactListResult;
  });

  const publish = Effect.fn("ThreadArtifactService.publish")(function* (
    input: ThreadArtifactPublishInput,
  ) {
    yield* requireLiveThread(input.threadId);
    const title = input.title.trim();
    if (title.length === 0 || title.length > 160) {
      return yield* new ThreadArtifactInvalidInputError({
        field: "title",
        reason: "must contain 1 to 160 characters",
      });
    }
    const description = input.description?.trim() || null;
    if (description !== null && description.length > 2_000) {
      return yield* new ThreadArtifactInvalidInputError({
        field: "description",
        reason: "must contain at most 2,000 characters",
      });
    }
    if (input.files.length === 0 || input.files.length > THREAD_ARTIFACT_MAX_FILES) {
      return yield* new ThreadArtifactQuotaExceededError({
        quota: "file-count",
        actual: input.files.length,
        maximum: THREAD_ARTIFACT_MAX_FILES,
      });
    }
    const normalizedFiles: ThreadArtifactPublishFile[] = [];
    const seenPaths = new Set<string>();
    let byteLength = 0;
    for (const file of input.files) {
      const normalizedPath = safeRelativePath(pathService, file.path);
      if (!normalizedPath || seenPaths.has(normalizedPath)) {
        return yield* new ThreadArtifactInvalidInputError({
          field: "files.path",
          reason: `unsafe or duplicate path: ${file.path}`,
        });
      }
      const extension = pathService.extname(normalizedPath).toLowerCase();
      if (input.kind === "web" && !SAFE_WEB_EXTENSIONS.has(extension)) {
        return yield* new ThreadArtifactInvalidInputError({
          field: "files.path",
          reason: `unsupported web bundle extension: ${extension || "none"}`,
        });
      }
      const derivedContentType = deriveArtifactMimeType(normalizedPath, file.bytes);
      if (
        !derivedContentType ||
        file.contentType.toLowerCase().split(";", 1)[0]?.trim() !== derivedContentType
      ) {
        return yield* new ThreadArtifactInvalidInputError({
          field: `files.${file.path}.contentType`,
          reason: "must match the file extension and validated bytes",
        });
      }
      if (
        (derivedContentType.startsWith("text/") ||
          derivedContentType === "application/json" ||
          derivedContentType === "image/svg+xml") &&
        decodeUtf8(file.bytes) === null
      ) {
        return yield* new ThreadArtifactInvalidInputError({
          field: `files.${file.path}`,
          reason: "text files must contain valid UTF-8",
        });
      }
      const maximum = LARGE_FILE_CONTENT_TYPES.has(derivedContentType)
        ? THREAD_ARTIFACT_LARGE_FILE_MAX_BYTES
        : THREAD_ARTIFACT_NORMAL_FILE_MAX_BYTES;
      if (file.bytes.byteLength > maximum) {
        return yield* new ThreadArtifactQuotaExceededError({
          quota: "file-bytes",
          actual: file.bytes.byteLength,
          maximum,
        });
      }
      if (input.kind === "web" && !validateClassicWebFile({ ...file, path: normalizedPath })) {
        return yield* new ThreadArtifactInvalidInputError({
          field: "files",
          reason: "web artifacts must be self-contained classic-script bundles",
        });
      }
      seenPaths.add(normalizedPath);
      byteLength += file.bytes.byteLength;
      normalizedFiles.push({ ...file, path: normalizedPath, contentType: derivedContentType });
    }
    if (byteLength > THREAD_ARTIFACT_REVISION_MAX_BYTES) {
      return yield* new ThreadArtifactQuotaExceededError({
        quota: "revision-bytes",
        actual: byteLength,
        maximum: THREAD_ARTIFACT_REVISION_MAX_BYTES,
      });
    }
    const entryPath = safeRelativePath(pathService, input.entryPath);
    const entry = normalizedFiles.find((file) => file.path === entryPath);
    if (!entryPath || !entry) {
      return yield* new ThreadArtifactInvalidInputError({
        field: "entryPath",
        reason: "must name one published file",
      });
    }
    const kindShapeError = validateKindShape(input.kind, normalizedFiles, entryPath);
    if (kindShapeError) {
      return yield* new ThreadArtifactInvalidInputError({
        field: "files",
        reason: kindShapeError,
      });
    }

    const existingByKey = yield* getArtifactRowByKey({
      threadId: input.threadId,
      key: input.key,
    }).pipe(Effect.mapError(mapStorage("checking the artifact key")));
    const artifactId =
      input.artifactId ??
      Option.getOrUndefined(existingByKey)?.artifactId ??
      ThreadArtifactId.make(NodeCrypto.randomUUID());
    const existing = yield* getArtifactRow({ threadId: input.threadId, artifactId }).pipe(
      Effect.mapError(mapStorage("checking the artifact")),
    );
    if (
      input.artifactId &&
      (Option.isNone(existing) ||
        (Option.isSome(existingByKey) && existingByKey.value.artifactId !== input.artifactId))
    ) {
      return yield* new ThreadArtifactNotFoundError({
        threadId: input.threadId,
        artifactId: input.artifactId,
      });
    }
    if (Option.isSome(existing) && existing.value.key !== input.key) {
      return yield* new ThreadArtifactInvalidInputError({
        field: "key",
        reason: "does not match the existing artifact",
      });
    }
    if (Option.isSome(existing) && existing.value.kind !== input.kind) {
      return yield* new ThreadArtifactInvalidInputError({
        field: "kind",
        reason: "cannot change an existing artifact's kind",
      });
    }
    const existingRevisions = Option.isSome(existing)
      ? yield* listRevisionRows({ artifactId }).pipe(
          Effect.mapError(mapStorage("counting revisions")),
        )
      : [];
    if (existingRevisions.length >= THREAD_ARTIFACT_MAX_REVISIONS) {
      return yield* new ThreadArtifactQuotaExceededError({
        quota: "revisions",
        actual: existingRevisions.length + 1,
        maximum: THREAD_ARTIFACT_MAX_REVISIONS,
      });
    }
    const total = yield* threadBytes({ threadId: input.threadId }).pipe(
      Effect.mapError(mapStorage("measuring thread storage")),
    );
    if (total.value + byteLength > THREAD_ARTIFACT_THREAD_MAX_BYTES) {
      return yield* new ThreadArtifactQuotaExceededError({
        quota: "thread-bytes",
        actual: total.value + byteLength,
        maximum: THREAD_ARTIFACT_THREAD_MAX_BYTES,
      });
    }

    const revision = (Option.isSome(existing) ? existing.value.currentRevision : 0) + 1;
    const now = DateTime.formatIso(yield* DateTime.now);
    const safeIcon = input.iconSvg ? sanitizeArtifactIconSvg(input.iconSvg) : null;
    const iconSource = safeIcon ? "provided" : "generated";
    const iconSvg = safeIcon ?? generatedIconSvg(input.kind, input.key);
    const stagingDirectory = pathService.join(
      config.artifactsDir,
      ".staging",
      NodeCrypto.randomUUID(),
    );
    const revisionDirectory = pathService.join(
      config.artifactsDir,
      artifactId,
      "revisions",
      String(revision),
    );
    yield* fileSystem
      .makeDirectory(stagingDirectory, { recursive: true })
      .pipe(Effect.mapError(mapStorage("creating a staging directory")));
    const stageWrite = Effect.gen(function* () {
      for (const file of normalizedFiles) {
        const target = pathService.join(stagingDirectory, file.path);
        yield* fileSystem.makeDirectory(pathService.dirname(target), { recursive: true });
        yield* fileSystem.writeFile(target, file.bytes);
      }
      yield* fileSystem.writeFileString(pathService.join(stagingDirectory, "icon.svg"), iconSvg);
      const manifest: ArtifactManifest = {
        version: 1,
        entryPath,
        files: normalizedFiles.map((file) => ({
          path: file.path,
          contentType: file.contentType,
          byteLength: file.bytes.byteLength,
        })),
      };
      yield* fileSystem.writeFileString(
        pathService.join(stagingDirectory, ".manifest.json"),
        encodeArtifactManifest(manifest),
      );
      yield* fileSystem.makeDirectory(pathService.dirname(revisionDirectory), { recursive: true });
      yield* fileSystem.rename(stagingDirectory, revisionDirectory);
    }).pipe(Effect.mapError(mapStorage("writing immutable revision files")));
    yield* stageWrite.pipe(
      Effect.tapError(() =>
        fileSystem.remove(stagingDirectory, { recursive: true, force: true }).pipe(Effect.ignore),
      ),
    );

    const artifact: ThreadArtifact = {
      artifactId,
      threadId: input.threadId,
      key: input.key,
      title,
      description,
      kind: input.kind,
      currentRevision: revision,
      archivedAt: null,
      createdAt: Option.isSome(existing) ? existing.value.createdAt : now,
      updatedAt: now,
    };
    const artifactRevision: ThreadArtifactRevision = {
      artifactId,
      revision,
      entryPath,
      contentType: entry.contentType,
      byteLength,
      fileCount: normalizedFiles.length,
      iconSource,
      createdAt: now,
    };
    const persist = sql
      .withTransaction(
        Effect.gen(function* () {
          if (Option.isNone(existing)) {
            yield* sql`
            INSERT INTO thread_artifacts (
              artifact_id, thread_id, artifact_key, title, description, kind, current_revision,
              archived_at, created_at, updated_at
            ) VALUES (
              ${artifact.artifactId}, ${artifact.threadId}, ${artifact.key}, ${artifact.title},
              ${artifact.description}, ${artifact.kind}, ${artifact.currentRevision}, NULL,
              ${artifact.createdAt}, ${artifact.updatedAt}
            )
          `;
          } else {
            yield* sql`
            UPDATE thread_artifacts
            SET title = ${artifact.title}, description = ${artifact.description},
                current_revision = ${artifact.currentRevision}, archived_at = NULL,
                updated_at = ${artifact.updatedAt}
            WHERE artifact_id = ${artifact.artifactId} AND thread_id = ${artifact.threadId}
          `;
          }
          yield* sql`
          INSERT INTO thread_artifact_revisions (
            artifact_id, revision, entry_path, content_type, byte_length,
            file_count, icon_source, created_at
          ) VALUES (
            ${artifactRevision.artifactId}, ${artifactRevision.revision},
            ${artifactRevision.entryPath}, ${artifactRevision.contentType},
            ${artifactRevision.byteLength}, ${artifactRevision.fileCount},
            ${artifactRevision.iconSource}, ${artifactRevision.createdAt}
          )
        `;
        }),
      )
      .pipe(Effect.mapError(mapStorage("committing revision metadata")));
    yield* persist.pipe(
      Effect.tapError(() =>
        fileSystem.remove(revisionDirectory, { recursive: true, force: true }).pipe(Effect.ignore),
      ),
    );
    yield* PubSub.publish(changes, input.threadId);
    return {
      ...toSummary(artifact, artifactRevision),
      revisions: [artifactRevision, ...existingRevisions],
    };
  });

  const setArchived = Effect.fn("ThreadArtifactService.setArchived")(function* (
    input: ThreadArtifactArchiveInput,
  ) {
    const current = yield* get(input);
    const now = DateTime.formatIso(yield* DateTime.now);
    yield* sql`
      UPDATE thread_artifacts
      SET archived_at = ${input.archived ? now : null}, updated_at = ${now}
      WHERE artifact_id = ${input.artifactId} AND thread_id = ${input.threadId}
    `.pipe(
      Effect.mapError(
        mapStorage(input.archived ? "archiving the artifact" : "restoring the artifact"),
      ),
    );
    yield* PubSub.publish(changes, input.threadId);
    return {
      ...current,
      artifact: {
        ...current.artifact,
        archivedAt: input.archived ? now : null,
        updatedAt: now,
      },
    };
  });

  const deleteArtifact = Effect.fn("ThreadArtifactService.deleteArtifact")(function* (input: {
    readonly threadId: ThreadId;
    readonly artifactId: ThreadArtifactId;
  }) {
    yield* requireLiveThread(input.threadId);
    const artifactRow = yield* getArtifactRow(input).pipe(
      Effect.mapError(mapStorage("reading metadata")),
    );
    if (Option.isNone(artifactRow)) {
      return yield* new ThreadArtifactNotFoundError(input);
    }
    // Bytes before rows, like cleanupDeletedThread: a crash in between leaves
    // metadata pointing at nothing — which reads loudly as an error — rather
    // than orphaned bytes nothing would ever reclaim.
    const safeDirectoryName =
      input.artifactId === pathService.basename(input.artifactId) &&
      input.artifactId !== "." &&
      input.artifactId !== ".." &&
      !input.artifactId.startsWith(".");
    if (safeDirectoryName) {
      yield* fileSystem
        .remove(pathService.join(config.artifactsDir, input.artifactId), {
          recursive: true,
          force: true,
        })
        .pipe(Effect.mapError(mapStorage("removing artifact bytes")));
    } else {
      yield* Effect.logWarning("skipping unsafe artifact storage directory during delete", input);
    }
    yield* sql
      .withTransaction(
        Effect.gen(function* () {
          yield* sql`DELETE FROM thread_artifact_revisions WHERE artifact_id = ${input.artifactId}`;
          yield* sql`
            DELETE FROM thread_artifacts
            WHERE artifact_id = ${input.artifactId} AND thread_id = ${input.threadId}
          `;
        }),
      )
      .pipe(Effect.mapError(mapStorage("removing artifact metadata")));
    yield* PubSub.publish(changes, input.threadId);
    return { threadId: input.threadId, artifactId: input.artifactId };
  });

  const cleanupDeletedThread = Effect.fn("ThreadArtifactService.cleanupDeletedThread")(function* (
    threadId: ThreadId,
  ) {
    const rows = yield* sql<{
      readonly artifactId: string;
      readonly revisionCount: number;
    }>`
        SELECT
          artifact.artifact_id AS "artifactId",
          COUNT(revision.revision) AS "revisionCount"
        FROM thread_artifacts artifact
        LEFT JOIN thread_artifact_revisions revision
          ON revision.artifact_id = artifact.artifact_id
        WHERE artifact.thread_id = ${threadId}
        GROUP BY artifact.artifact_id
        ORDER BY artifact.artifact_id ASC
      `.pipe(Effect.mapError(mapStorage("listing deleted-thread artifacts")));

    yield* Effect.forEach(
      rows,
      (row) => {
        const safeDirectoryName =
          row.artifactId === pathService.basename(row.artifactId) &&
          row.artifactId !== "." &&
          row.artifactId !== ".." &&
          !row.artifactId.startsWith(".");
        if (!safeDirectoryName) {
          return Effect.logWarning("skipping unsafe artifact storage directory during cleanup", {
            threadId,
            artifactId: row.artifactId,
          });
        }
        return fileSystem
          .remove(pathService.join(config.artifactsDir, row.artifactId), {
            recursive: true,
            force: true,
          })
          .pipe(Effect.mapError(mapStorage("removing deleted-thread artifact bytes")));
      },
      { concurrency: 1, discard: true },
    );

    yield* sql
      .withTransaction(
        Effect.gen(function* () {
          yield* sql`
              DELETE FROM thread_artifact_revisions
              WHERE artifact_id IN (
                SELECT artifact_id FROM thread_artifacts WHERE thread_id = ${threadId}
              )
            `;
          yield* sql`DELETE FROM thread_artifacts WHERE thread_id = ${threadId}`;
        }),
      )
      .pipe(Effect.mapError(mapStorage("removing deleted-thread artifact metadata")));
    yield* PubSub.publish(changes, threadId);
    return {
      artifactCount: rows.length,
      revisionCount: rows.reduce((total, row) => total + row.revisionCount, 0),
    };
  });

  const subscribe: ThreadArtifactServiceShape["subscribe"] = (input) =>
    Stream.unwrap(
      Effect.gen(function* () {
        yield* requireLiveThread(input.threadId);
        const subscription = yield* PubSub.subscribe(changes);
        const updates = Stream.fromSubscription(subscription).pipe(
          Stream.filter((threadId) => threadId === input.threadId),
          Stream.mapEffect(() => list(input)),
          Stream.map((snapshot) => ({ _tag: "snapshot" as const, snapshot })),
        );
        return Stream.concat(
          Stream.fromEffect(list(input)).pipe(
            Stream.map((snapshot) => ({ _tag: "snapshot" as const, snapshot })),
          ),
          updates,
        );
      }),
    );

  return {
    list,
    get,
    publish,
    setArchived,
    deleteArtifact,
    subscribe,
    cleanupDeletedThread,
  } satisfies ThreadArtifactServiceShape;
});

export const layer = Layer.effect(ThreadArtifactService, makeThreadArtifactService);
