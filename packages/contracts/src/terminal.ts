import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * Client-side id for the first shell opened on a thread. Ids are uniformly
 * `term-N`; there's no "default" intrinsic. Kept as a named constant so callers
 * that want "the primary shell" don't hardcode `"term-1"`.
 */
export const DEFAULT_TERMINAL_ID = "term-1";

const TrimmedNonEmptyStringSchema = TrimmedNonEmptyString;
const TerminalColsSchema = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).check(
  Schema.isLessThanOrEqualTo(1000),
);
const TerminalRowsSchema = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).check(
  Schema.isLessThanOrEqualTo(500),
);
const TerminalIdSchema = TrimmedNonEmptyStringSchema.check(Schema.isMaxLength(128));
const TerminalEnvKeySchema = Schema.String.check(
  Schema.isPattern(/^[A-Za-z_][A-Za-z0-9_]*$/),
).check(Schema.isMaxLength(128));
const TerminalEnvValueSchema = Schema.String.check(Schema.isMaxLength(8_192));
const TerminalEnvSchema = Schema.Record(TerminalEnvKeySchema, TerminalEnvValueSchema).check(
  Schema.isMaxProperties(128),
);

export const TerminalThreadInput = Schema.Struct({
  threadId: TrimmedNonEmptyStringSchema,
});
export type TerminalThreadInput = typeof TerminalThreadInput.Type;

/** Terminal ids are ALWAYS chosen by the client and sent explicitly — no server-side allocation. */
const TerminalSessionInput = Schema.Struct({
  ...TerminalThreadInput.fields,
  terminalId: TerminalIdSchema,
});
export type TerminalSessionInput = Schema.Codec.Encoded<typeof TerminalSessionInput>;

/**
 * Stable per-app-instance id used to arbitrate shared-PTY geometry. The last
 * client to open, type into, or successfully resize a terminal owns its grid;
 * resize requests from other clients are ignored while the owner is active,
 * so two machines viewing the same terminal cannot ping-pong the PTY between
 * their pane sizes (each swap makes ConPTY rewrap and TUIs repaint).
 */
export const TerminalClientIdSchema = TrimmedNonEmptyStringSchema.check(Schema.isMaxLength(128));

export const TerminalOpenInput = Schema.Struct({
  ...TerminalSessionInput.fields,
  cwd: TrimmedNonEmptyStringSchema,
  worktreePath: Schema.optional(Schema.NullOr(TrimmedNonEmptyStringSchema)),
  cols: Schema.optional(TerminalColsSchema),
  rows: Schema.optional(TerminalRowsSchema),
  env: Schema.optional(TerminalEnvSchema),
  clientId: Schema.optional(TerminalClientIdSchema),
});
export type TerminalOpenInput = Schema.Codec.Encoded<typeof TerminalOpenInput>;

export const TerminalAttachInput = Schema.Struct({
  ...TerminalSessionInput.fields,
  cwd: Schema.optional(TrimmedNonEmptyStringSchema),
  worktreePath: Schema.optional(Schema.NullOr(TrimmedNonEmptyStringSchema)),
  cols: Schema.optional(TerminalColsSchema),
  rows: Schema.optional(TerminalRowsSchema),
  env: Schema.optional(TerminalEnvSchema),
  restartIfNotRunning: Schema.optional(Schema.Boolean),
});
export type TerminalAttachInput = Schema.Codec.Encoded<typeof TerminalAttachInput>;

export const TerminalWriteInput = Schema.Struct({
  ...TerminalSessionInput.fields,
  data: Schema.String.check(Schema.isNonEmpty()).check(Schema.isMaxLength(65_536)),
  clientId: Schema.optional(TerminalClientIdSchema),
});
export type TerminalWriteInput = Schema.Codec.Encoded<typeof TerminalWriteInput>;

/** One-shot inventory. Does not spawn a session. */
export const TerminalListInput = Schema.Struct({
  threadId: Schema.optional(TrimmedNonEmptyStringSchema),
});
export type TerminalListInput = typeof TerminalListInput.Type;

/** One-shot history read. Does not spawn or resize a session. */
export const TerminalReadInput = Schema.Struct({
  ...TerminalSessionInput.fields,
});
export type TerminalReadInput = Schema.Codec.Encoded<typeof TerminalReadInput>;

export const TerminalResizeInput = Schema.Struct({
  ...TerminalSessionInput.fields,
  cols: TerminalColsSchema,
  rows: TerminalRowsSchema,
  clientId: Schema.optional(TerminalClientIdSchema),
});
export type TerminalResizeInput = Schema.Codec.Encoded<typeof TerminalResizeInput>;

export const TerminalClearInput = TerminalSessionInput;
export type TerminalClearInput = Schema.Codec.Encoded<typeof TerminalClearInput>;

export const TerminalRestartInput = Schema.Struct({
  ...TerminalSessionInput.fields,
  cwd: TrimmedNonEmptyStringSchema,
  worktreePath: Schema.optional(Schema.NullOr(TrimmedNonEmptyStringSchema)),
  cols: TerminalColsSchema,
  rows: TerminalRowsSchema,
  env: Schema.optional(TerminalEnvSchema),
});
export type TerminalRestartInput = Schema.Codec.Encoded<typeof TerminalRestartInput>;

export const TerminalCloseInput = Schema.Struct({
  ...TerminalThreadInput.fields,
  terminalId: Schema.optional(TerminalIdSchema),
  deleteHistory: Schema.optional(Schema.Boolean),
});
export type TerminalCloseInput = typeof TerminalCloseInput.Type;

export const TerminalSessionStatus = Schema.Literals(["starting", "running", "exited", "error"]);
export type TerminalSessionStatus = typeof TerminalSessionStatus.Type;

export const TerminalSessionSnapshot = Schema.Struct({
  threadId: Schema.String.check(Schema.isNonEmpty()),
  terminalId: Schema.String.check(Schema.isNonEmpty()),
  cwd: Schema.String.check(Schema.isNonEmpty()),
  worktreePath: Schema.NullOr(TrimmedNonEmptyStringSchema),
  status: TerminalSessionStatus,
  pid: Schema.NullOr(Schema.Int.check(Schema.isGreaterThan(0))),
  history: Schema.String,
  exitCode: Schema.NullOr(Schema.Int),
  exitSignal: Schema.NullOr(Schema.Int),
  /** Server-computed display title (idle shell vs subprocess command). */
  label: Schema.String.check(Schema.isMaxLength(128)),
  updatedAt: Schema.String,
  sequence: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  /**
   * The PTY's current grid. Every viewer must render at this geometry —
   * absolute cursor addressing from full-screen programs only lines up on
   * the grid the PTY actually has, not on whatever a pane happens to fit.
   */
  cols: Schema.optional(TerminalColsSchema),
  rows: Schema.optional(TerminalRowsSchema),
});
export type TerminalSessionSnapshot = typeof TerminalSessionSnapshot.Type;

export const TerminalSummary = Schema.Struct({
  threadId: Schema.String.check(Schema.isNonEmpty()),
  terminalId: Schema.String.check(Schema.isNonEmpty()),
  cwd: Schema.String.check(Schema.isNonEmpty()),
  worktreePath: Schema.NullOr(TrimmedNonEmptyStringSchema),
  status: TerminalSessionStatus,
  pid: Schema.NullOr(Schema.Int.check(Schema.isGreaterThan(0))),
  exitCode: Schema.NullOr(Schema.Int),
  exitSignal: Schema.NullOr(Schema.Int),
  hasRunningSubprocess: Schema.Boolean,
  /**
   * True when the pane is mid-turn. An idle agent TUI still has a subprocess
   * (`hasRunningSubprocess`) but is not working.
   */
  working: Schema.optionalKey(Schema.Boolean),
  /** ISO time `working` last flipped on; drives the UI's "Working" clock. */
  workingSince: Schema.optionalKey(Schema.String),
  /** Server-computed display title (idle shell vs subprocess command). */
  label: Schema.String.check(Schema.isMaxLength(128)),
  updatedAt: Schema.String,
  /** The PTY's current grid; see TerminalSessionSnapshot.cols. */
  cols: Schema.optionalKey(TerminalColsSchema),
  rows: Schema.optionalKey(TerminalRowsSchema),
  /**
   * Client that currently owns the PTY grid (see TerminalClientIdSchema).
   * Other clients render this grid scaled instead of resizing the PTY.
   */
  geometryOwner: Schema.optionalKey(Schema.String),
});
export type TerminalSummary = typeof TerminalSummary.Type;

export const TerminalListResult = Schema.Struct({
  terminals: Schema.Array(TerminalSummary),
});
export type TerminalListResult = typeof TerminalListResult.Type;

const TerminalMetadataSnapshotEvent = Schema.Struct({
  type: Schema.Literal("snapshot"),
  terminals: Schema.Array(TerminalSummary),
});

const TerminalMetadataUpsertEvent = Schema.Struct({
  type: Schema.Literal("upsert"),
  terminal: TerminalSummary,
});

const TerminalMetadataRemoveEvent = Schema.Struct({
  type: Schema.Literal("remove"),
  threadId: Schema.String.check(Schema.isNonEmpty()),
  terminalId: Schema.String.check(Schema.isNonEmpty()),
});

export const TerminalResyncRequiredEvent = Schema.Struct({
  type: Schema.Literal("resync-required"),
  reason: Schema.Literal("slow-consumer"),
});
export type TerminalResyncRequiredEvent = typeof TerminalResyncRequiredEvent.Type;

export const TerminalMetadataStreamEvent = Schema.Union([
  TerminalMetadataSnapshotEvent,
  TerminalMetadataUpsertEvent,
  TerminalMetadataRemoveEvent,
]);
export type TerminalMetadataStreamEvent = typeof TerminalMetadataStreamEvent.Type;
export const TerminalMetadataStreamItem = Schema.Union([
  TerminalMetadataStreamEvent,
  TerminalResyncRequiredEvent,
]);
export type TerminalMetadataStreamItem = typeof TerminalMetadataStreamItem.Type;

/**
 * Server-synced pane topology for one thread's terminal workspace. Groups,
 * split trees, names, and ordering were per-client localStorage before,
 * so two clients viewing the same thread showed different workspaces.
 * The server document is authoritative: clients push local edits with
 * `terminal.setLayout` (last write wins, revision bumps monotonically)
 * and follow broadcasts from `subscribeTerminalLayouts`.
 */
const TerminalPaneNodeRef = Schema.suspend((): Schema.Codec<TerminalPaneNode> => TerminalPaneNode);
export const TerminalPaneNode = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("terminal"),
    terminalId: TerminalIdSchema,
  }),
  Schema.Struct({
    kind: Schema.Literal("split"),
    direction: Schema.Literals(["horizontal", "vertical"]),
    children: Schema.Array(TerminalPaneNodeRef).check(Schema.isMaxLength(16)),
    sizes: Schema.optional(Schema.Array(Schema.Number).check(Schema.isMaxLength(16))),
  }),
]);
export type TerminalPaneNode =
  | { readonly kind: "terminal"; readonly terminalId: string }
  | {
      readonly kind: "split";
      readonly direction: "horizontal" | "vertical";
      readonly children: ReadonlyArray<TerminalPaneNode>;
      readonly sizes?: ReadonlyArray<number> | undefined;
    };

export const TerminalLayoutGroup = Schema.Struct({
  id: TrimmedNonEmptyStringSchema.check(Schema.isMaxLength(160)),
  name: Schema.optional(Schema.String.check(Schema.isMaxLength(120))),
  terminalIds: Schema.Array(TerminalIdSchema).check(Schema.isMaxLength(16)),
  layout: Schema.optional(TerminalPaneNode),
});
export type TerminalLayoutGroup = typeof TerminalLayoutGroup.Type;

export const TerminalThreadLayout = Schema.Struct({
  threadId: TrimmedNonEmptyStringSchema,
  revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  groups: Schema.Array(TerminalLayoutGroup).check(Schema.isMaxLength(64)),
  updatedAt: Schema.String,
});
export type TerminalThreadLayout = typeof TerminalThreadLayout.Type;

export const TerminalGetLayoutInput = Schema.Struct({
  threadId: TrimmedNonEmptyStringSchema,
});
export type TerminalGetLayoutInput = typeof TerminalGetLayoutInput.Type;

export const TerminalGetLayoutResult = Schema.Struct({
  layout: Schema.NullOr(TerminalThreadLayout),
});
export type TerminalGetLayoutResult = typeof TerminalGetLayoutResult.Type;

export const TerminalSetLayoutInput = Schema.Struct({
  threadId: TrimmedNonEmptyStringSchema,
  groups: Schema.Array(TerminalLayoutGroup).check(Schema.isMaxLength(64)),
  /**
   * Revision the client based this edit on; informational. The server
   * accepts the write regardless (last write wins) so a stale client
   * converges on the next broadcast instead of erroring mid-drag.
   */
  baseRevision: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
});
export type TerminalSetLayoutInput = typeof TerminalSetLayoutInput.Type;

const TerminalLayoutSnapshotEvent = Schema.Struct({
  type: Schema.Literal("snapshot"),
  layouts: Schema.Array(TerminalThreadLayout),
});

const TerminalLayoutUpsertEvent = Schema.Struct({
  type: Schema.Literal("layout"),
  layout: TerminalThreadLayout,
});

export const TerminalLayoutStreamEvent = Schema.Union([
  TerminalLayoutSnapshotEvent,
  TerminalLayoutUpsertEvent,
]);
export type TerminalLayoutStreamEvent = typeof TerminalLayoutStreamEvent.Type;
export const TerminalLayoutStreamItem = Schema.Union([
  TerminalLayoutStreamEvent,
  TerminalResyncRequiredEvent,
]);
export type TerminalLayoutStreamItem = typeof TerminalLayoutStreamItem.Type;

const TerminalEventBaseSchema = Schema.Struct({
  threadId: Schema.String.check(Schema.isNonEmpty()),
  terminalId: Schema.String.check(Schema.isNonEmpty()),
  sequence: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
});

const TerminalStartedEvent = Schema.Struct({
  ...TerminalEventBaseSchema.fields,
  type: Schema.Literal("started"),
  snapshot: TerminalSessionSnapshot,
});

const TerminalOutputEvent = Schema.Struct({
  ...TerminalEventBaseSchema.fields,
  type: Schema.Literal("output"),
  data: Schema.String,
});

const TerminalExitedEvent = Schema.Struct({
  ...TerminalEventBaseSchema.fields,
  type: Schema.Literal("exited"),
  exitCode: Schema.NullOr(Schema.Int),
  exitSignal: Schema.NullOr(Schema.Int),
});

const TerminalClosedEvent = Schema.Struct({
  ...TerminalEventBaseSchema.fields,
  type: Schema.Literal("closed"),
});

const TerminalErrorEvent = Schema.Struct({
  ...TerminalEventBaseSchema.fields,
  type: Schema.Literal("error"),
  message: Schema.String.check(Schema.isNonEmpty()),
});

const TerminalClearedEvent = Schema.Struct({
  ...TerminalEventBaseSchema.fields,
  type: Schema.Literal("cleared"),
});

const TerminalRestartedEvent = Schema.Struct({
  ...TerminalEventBaseSchema.fields,
  type: Schema.Literal("restarted"),
  snapshot: TerminalSessionSnapshot,
});

const TerminalActivityEvent = Schema.Struct({
  ...TerminalEventBaseSchema.fields,
  type: Schema.Literal("activity"),
  hasRunningSubprocess: Schema.Boolean,
  label: Schema.String.check(Schema.isMaxLength(128)),
});

export const TerminalEvent = Schema.Union([
  TerminalStartedEvent,
  TerminalOutputEvent,
  TerminalExitedEvent,
  TerminalClosedEvent,
  TerminalErrorEvent,
  TerminalClearedEvent,
  TerminalRestartedEvent,
  TerminalActivityEvent,
]);
export type TerminalEvent = typeof TerminalEvent.Type;
export const TerminalEventStreamItem = Schema.Union([TerminalEvent, TerminalResyncRequiredEvent]);
export type TerminalEventStreamItem = typeof TerminalEventStreamItem.Type;

const TerminalAttachSnapshotEvent = Schema.Struct({
  type: Schema.Literal("snapshot"),
  snapshot: TerminalSessionSnapshot,
});

export const TerminalAttachStreamEvent = Schema.Union([
  TerminalAttachSnapshotEvent,
  TerminalOutputEvent,
  TerminalExitedEvent,
  TerminalClosedEvent,
  TerminalErrorEvent,
  TerminalClearedEvent,
  TerminalRestartedEvent,
  TerminalActivityEvent,
]);
export type TerminalAttachStreamEvent = typeof TerminalAttachStreamEvent.Type;
export const TerminalAttachStreamItem = Schema.Union([
  TerminalAttachStreamEvent,
  TerminalResyncRequiredEvent,
]);
export type TerminalAttachStreamItem = typeof TerminalAttachStreamItem.Type;

export class TerminalCwdNotFoundError extends Schema.TaggedErrorClass<TerminalCwdNotFoundError>()(
  "TerminalCwdNotFoundError",
  {
    cwd: Schema.String,
  },
) {
  override get message() {
    return `Terminal cwd does not exist: ${this.cwd}`;
  }
}

export class TerminalCwdNotDirectoryError extends Schema.TaggedErrorClass<TerminalCwdNotDirectoryError>()(
  "TerminalCwdNotDirectoryError",
  {
    cwd: Schema.String,
  },
) {
  override get message() {
    return `Terminal cwd is not a directory: ${this.cwd}`;
  }
}

export class TerminalCwdStatError extends Schema.TaggedErrorClass<TerminalCwdStatError>()(
  "TerminalCwdStatError",
  {
    cwd: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message() {
    return `Failed to access terminal cwd: ${this.cwd}`;
  }
}

export const TerminalCwdError = Schema.Union([
  TerminalCwdNotFoundError,
  TerminalCwdNotDirectoryError,
  TerminalCwdStatError,
]);
export type TerminalCwdError = typeof TerminalCwdError.Type;

export class TerminalHistoryError extends Schema.TaggedErrorClass<TerminalHistoryError>()(
  "TerminalHistoryError",
  {
    operation: Schema.Literals(["read", "truncate", "migrate"]),
    threadId: Schema.String,
    terminalId: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message() {
    return `Failed to ${this.operation} terminal history for thread: ${this.threadId}, terminal: ${this.terminalId}`;
  }
}

export class TerminalSessionLookupError extends Schema.TaggedErrorClass<TerminalSessionLookupError>()(
  "TerminalSessionLookupError",
  {
    threadId: Schema.String,
    terminalId: Schema.String,
  },
) {
  override get message() {
    return `Unknown terminal thread: ${this.threadId}, terminal: ${this.terminalId}`;
  }
}

export class TerminalNotRunningError extends Schema.TaggedErrorClass<TerminalNotRunningError>()(
  "TerminalNotRunningError",
  {
    threadId: Schema.String,
    terminalId: Schema.String,
  },
) {
  override get message() {
    return `Terminal is not running for thread: ${this.threadId}, terminal: ${this.terminalId}`;
  }
}

export class TerminalWriteError extends Schema.TaggedErrorClass<TerminalWriteError>()(
  "TerminalWriteError",
  {
    threadId: Schema.String,
    terminalId: Schema.String,
    terminalPid: Schema.Number,
    cause: Schema.Defect(),
  },
) {
  override get message() {
    return `Failed to write to terminal for thread: ${this.threadId}, terminal: ${this.terminalId}, PID: ${this.terminalPid}`;
  }
}

export class TerminalResizeError extends Schema.TaggedErrorClass<TerminalResizeError>()(
  "TerminalResizeError",
  {
    threadId: Schema.String,
    terminalId: Schema.String,
    terminalPid: Schema.Number,
    cols: TerminalColsSchema,
    rows: TerminalRowsSchema,
    cause: Schema.Defect(),
  },
) {
  override get message() {
    return `Failed to resize terminal for thread: ${this.threadId}, terminal: ${this.terminalId}, PID: ${this.terminalPid} to ${this.cols}x${this.rows}`;
  }
}

export const TerminalError = Schema.Union([
  TerminalCwdError,
  TerminalHistoryError,
  TerminalSessionLookupError,
  TerminalNotRunningError,
  TerminalWriteError,
  TerminalResizeError,
]);
export type TerminalError = typeof TerminalError.Type;
