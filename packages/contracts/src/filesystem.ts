import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";

const FILESYSTEM_PATH_MAX_LENGTH = 512;

export const FilesystemBrowseInput = Schema.Struct({
  partialPath: TrimmedNonEmptyString.check(Schema.isMaxLength(FILESYSTEM_PATH_MAX_LENGTH)),
  cwd: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(FILESYSTEM_PATH_MAX_LENGTH))),
});
export type FilesystemBrowseInput = typeof FilesystemBrowseInput.Type;

export const FilesystemBrowseEntry = Schema.Struct({
  name: TrimmedNonEmptyString,
  fullPath: TrimmedNonEmptyString,
});
export type FilesystemBrowseEntry = typeof FilesystemBrowseEntry.Type;

export const FilesystemBrowseResult = Schema.Struct({
  parentPath: TrimmedNonEmptyString,
  entries: Schema.Array(FilesystemBrowseEntry),
});
export type FilesystemBrowseResult = typeof FilesystemBrowseResult.Type;

export const FilesystemBrowseFailure = Schema.Literals([
  "windows_path_unsupported",
  "current_project_required",
  "read_directory_failed",
]);
export type FilesystemBrowseFailure = typeof FilesystemBrowseFailure.Type;

function decodedFilesystemBrowseErrorMessage(props: object): string | undefined {
  if (!("message" in props)) return undefined;
  return typeof props.message === "string" ? props.message : undefined;
}

export class FilesystemBrowseError extends Schema.TaggedErrorClass<FilesystemBrowseError>()(
  "FilesystemBrowseError",
  {
    partialPath: Schema.optional(TrimmedNonEmptyString),
    cwd: Schema.optional(TrimmedNonEmptyString),
    failure: Schema.optional(FilesystemBrowseFailure),
    parentPath: Schema.optional(TrimmedNonEmptyString),
    platform: Schema.optional(TrimmedNonEmptyString),
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  // Structured diagnostics stay optional for rolling compatibility with legacy message-only
  // payloads, while new call sites must provide the request context and failure classification.
  // @effect-diagnostics-next-line overriddenSchemaConstructor:off
  constructor(props: {
    readonly partialPath: string;
    readonly cwd?: string | undefined;
    readonly failure: FilesystemBrowseFailure;
    readonly parentPath?: string;
    readonly platform?: string;
    readonly cause?: unknown;
  }) {
    const cwd = props.cwd === undefined ? "" : ` from '${props.cwd}'`;
    super({
      ...props,
      message:
        decodedFilesystemBrowseErrorMessage(props) ??
        `Failed to browse filesystem path '${props.partialPath}'${cwd}.`,
    } as any);
  }
}

/**
 * Existence probe for absolute host paths — the back end of bare-path
 * detection in chat prose. A message that mentions
 * `/Users/me/project/report.png` in plain text (no markdown link, no code
 * span) becomes a clickable reference only once the host confirms the path
 * is real; this is that confirmation, batched so one message costs one
 * round trip. Relative paths and anything unreadable answer `missing`.
 */
export const FILESYSTEM_PATHS_EXIST_MAX_PATHS = 64;

export const FilesystemPathKind = Schema.Literals(["file", "directory", "missing"]);
export type FilesystemPathKind = typeof FilesystemPathKind.Type;

export const FilesystemPathsExistInput = Schema.Struct({
  paths: Schema.Array(
    TrimmedNonEmptyString.check(Schema.isMaxLength(FILESYSTEM_PATH_MAX_LENGTH)),
  ).check(Schema.isMaxLength(FILESYSTEM_PATHS_EXIST_MAX_PATHS)),
});
export type FilesystemPathsExistInput = typeof FilesystemPathsExistInput.Type;

export const FilesystemPathExistence = Schema.Struct({
  path: TrimmedNonEmptyString,
  kind: FilesystemPathKind,
});
export type FilesystemPathExistence = typeof FilesystemPathExistence.Type;

export const FilesystemPathsExistResult = Schema.Struct({
  entries: Schema.Array(FilesystemPathExistence),
});
export type FilesystemPathsExistResult = typeof FilesystemPathsExistResult.Type;
