import * as Schema from "effect/Schema";

import {
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";

export const ThreadArtifactId = TrimmedNonEmptyString.check(Schema.isMaxLength(128)).pipe(
  Schema.brand("ThreadArtifactId"),
);
export type ThreadArtifactId = typeof ThreadArtifactId.Type;

export const ThreadArtifactKind = Schema.Literals([
  "structured",
  "markdown",
  "image",
  "pdf",
  "web",
]);
export type ThreadArtifactKind = typeof ThreadArtifactKind.Type;

export const ThreadArtifactKey = TrimmedNonEmptyString.check(
  Schema.isPattern(/^[a-z0-9][a-z0-9._-]{0,127}$/u),
).pipe(Schema.brand("ThreadArtifactKey"));
export type ThreadArtifactKey = typeof ThreadArtifactKey.Type;

export const ThreadArtifactRevision = Schema.Struct({
  artifactId: ThreadArtifactId,
  revision: PositiveInt,
  entryPath: TrimmedNonEmptyString.check(Schema.isMaxLength(512)),
  contentType: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
  byteLength: NonNegativeInt,
  fileCount: PositiveInt,
  iconSource: Schema.Literals(["provided", "generated"]),
  createdAt: IsoDateTime,
});
export type ThreadArtifactRevision = typeof ThreadArtifactRevision.Type;

export const ThreadArtifact = Schema.Struct({
  artifactId: ThreadArtifactId,
  threadId: ThreadId,
  key: ThreadArtifactKey,
  title: TrimmedNonEmptyString.check(Schema.isMaxLength(160)),
  description: Schema.NullOr(Schema.String.check(Schema.isMaxLength(2_000))),
  kind: ThreadArtifactKind,
  currentRevision: PositiveInt,
  archivedAt: Schema.NullOr(IsoDateTime),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type ThreadArtifact = typeof ThreadArtifact.Type;

export const ThreadArtifactSummary = Schema.Struct({
  artifact: ThreadArtifact,
  revision: ThreadArtifactRevision,
  entryResource: Schema.TaggedStruct("artifact-revision", {
    threadId: ThreadId,
    artifactId: ThreadArtifactId,
    revision: PositiveInt,
    path: TrimmedNonEmptyString.check(Schema.isMaxLength(512)),
  }),
  iconResource: Schema.TaggedStruct("artifact-icon", {
    threadId: ThreadId,
    artifactId: ThreadArtifactId,
    revision: PositiveInt,
  }),
});
export type ThreadArtifactSummary = typeof ThreadArtifactSummary.Type;

export const ThreadArtifactListInput = Schema.Struct({
  threadId: ThreadId,
  includeArchived: Schema.optional(Schema.Boolean),
});
export type ThreadArtifactListInput = typeof ThreadArtifactListInput.Type;

export const ThreadArtifactListResult = Schema.Struct({
  threadId: ThreadId,
  artifacts: Schema.Array(ThreadArtifactSummary),
});
export type ThreadArtifactListResult = typeof ThreadArtifactListResult.Type;

export const ThreadArtifactGetInput = Schema.Struct({
  threadId: ThreadId,
  artifactId: ThreadArtifactId,
});
export type ThreadArtifactGetInput = typeof ThreadArtifactGetInput.Type;

export const ThreadArtifactArchiveInput = ThreadArtifactGetInput;
export type ThreadArtifactArchiveInput = typeof ThreadArtifactArchiveInput.Type;

export const ThreadArtifactDetail = Schema.Struct({
  artifact: ThreadArtifact,
  revision: ThreadArtifactRevision,
  revisions: Schema.Array(ThreadArtifactRevision),
  entryResource: ThreadArtifactSummary.fields.entryResource,
  iconResource: ThreadArtifactSummary.fields.iconResource,
});
export type ThreadArtifactDetail = typeof ThreadArtifactDetail.Type;

export const ThreadArtifactStreamItem = Schema.TaggedStruct("snapshot", {
  snapshot: ThreadArtifactListResult,
});
export type ThreadArtifactStreamItem = typeof ThreadArtifactStreamItem.Type;

export class ThreadArtifactNotFoundError extends Schema.TaggedErrorClass<ThreadArtifactNotFoundError>()(
  "ThreadArtifactNotFoundError",
  {
    threadId: ThreadId,
    artifactId: Schema.optional(ThreadArtifactId),
  },
) {
  override get message(): string {
    return "The requested thread artifact was not found.";
  }
}

export class ThreadArtifactInvalidInputError extends Schema.TaggedErrorClass<ThreadArtifactInvalidInputError>()(
  "ThreadArtifactInvalidInputError",
  {
    field: Schema.String,
    reason: Schema.String,
  },
) {
  override get message(): string {
    return `Invalid artifact ${this.field}: ${this.reason}`;
  }
}

export class ThreadArtifactQuotaExceededError extends Schema.TaggedErrorClass<ThreadArtifactQuotaExceededError>()(
  "ThreadArtifactQuotaExceededError",
  {
    quota: Schema.Literals([
      "revision-bytes",
      "file-bytes",
      "file-count",
      "revisions",
      "thread-bytes",
    ]),
    actual: NonNegativeInt,
    maximum: PositiveInt,
  },
) {
  override get message(): string {
    return `Artifact quota ${this.quota} was exceeded (${this.actual}; maximum ${this.maximum}).`;
  }
}

export class ThreadArtifactStorageError extends Schema.TaggedErrorClass<ThreadArtifactStorageError>()(
  "ThreadArtifactStorageError",
  {
    operation: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Artifact storage failed while ${this.operation}.`;
  }
}

export const ThreadArtifactError = Schema.Union([
  ThreadArtifactNotFoundError,
  ThreadArtifactInvalidInputError,
  ThreadArtifactQuotaExceededError,
  ThreadArtifactStorageError,
]);
export type ThreadArtifactError = typeof ThreadArtifactError.Type;
