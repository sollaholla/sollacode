import {
  ThreadArtifactDetail,
  ThreadArtifactError,
  ThreadArtifactId,
  ThreadArtifactKey,
  ThreadArtifactKind,
  ThreadArtifactListResult,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const ArtifactFile = Schema.Struct({
  path: Schema.String.check(Schema.isMaxLength(512)),
  contentType: Schema.String.check(Schema.isMaxLength(128)),
  text: Schema.optional(Schema.String.check(Schema.isMaxLength(5 * 1024 * 1024))),
  dataBase64: Schema.optional(Schema.String.check(Schema.isMaxLength(28 * 1024 * 1024))),
  localPath: Schema.optional(Schema.String.check(Schema.isMaxLength(4_096))).annotate({
    description:
      "Path to read the bytes from, relative to localDir (or absolute inside it). The host reads and encodes the file, so its contents never pass through the model. Preferred for anything already on disk, and the only way to publish a bundle larger than one response.",
  }),
});

export const ThreadArtifactToolInput = Schema.Struct({
  action: Schema.Literals(["list", "get", "publish", "archive", "restore"]),
  artifactId: Schema.optional(ThreadArtifactId),
  key: Schema.optional(ThreadArtifactKey).annotate({
    description:
      "Stable lowercase key for publish (for example release-notes). Reusing it publishes a new immutable revision without retaining artifactId.",
  }),
  includeArchived: Schema.optional(Schema.Boolean),
  title: Schema.optional(Schema.String.check(Schema.isMaxLength(160))),
  description: Schema.optional(Schema.NullOr(Schema.String.check(Schema.isMaxLength(2_000)))),
  kind: Schema.optional(ThreadArtifactKind),
  entryPath: Schema.optional(Schema.String.check(Schema.isMaxLength(512))),
  files: Schema.optional(Schema.Array(ArtifactFile).check(Schema.isMaxLength(256))),
  localDir: Schema.optional(Schema.String.check(Schema.isMaxLength(4_096))).annotate({
    description:
      "Directory that localPath entries are read from. Required when any file uses localPath. Every path must resolve inside it once symlinks are followed.",
  }),
  iconSvg: Schema.optional(Schema.String.check(Schema.isMaxLength(16 * 1024))),
});
export type ThreadArtifactToolInput = typeof ThreadArtifactToolInput.Type;

export const ThreadArtifactToolResult = Schema.Struct({
  action: Schema.String,
  status: Schema.String,
  list: Schema.optional(ThreadArtifactListResult),
  detail: Schema.optional(ThreadArtifactDetail),
  contentUrl: Schema.optional(Schema.String),
  iconUrl: Schema.optional(Schema.String),
  openPath: Schema.optional(Schema.String),
  deepLink: Schema.optional(Schema.String),
  resourceUri: Schema.optional(Schema.String),
  expiresAt: Schema.optional(Schema.Number),
});

export const ThreadArtifactToolError = ThreadArtifactError;
