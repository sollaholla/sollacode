import * as Schema from "effect/Schema";
import * as SchemaIssue from "effect/SchemaIssue";

function summarizeSchemaIssue(issue: SchemaIssue.Issue): string {
  switch (issue._tag) {
    case "Filter":
    case "Encoding":
    case "Pointer":
      return `${issue._tag}(${summarizeSchemaIssue(issue.issue)})`;
    case "Composite":
    case "AnyOf":
      return `${issue._tag}(${issue.issues.map(summarizeSchemaIssue).join(",")})`;
    default:
      return issue._tag;
  }
}

// ===============================
// Core Persistence Errors
// ===============================

export const PersistenceErrorCorrelation = Schema.Union([
  Schema.Struct({ sessionId: Schema.String }),
  Schema.Struct({ currentSessionId: Schema.String }),
  Schema.Struct({ pairingLinkId: Schema.String }),
  Schema.Struct({ threadId: Schema.String }),
]);
export type PersistenceErrorCorrelation = typeof PersistenceErrorCorrelation.Type;

/** Explain storage failures across the SQL adapter's nested causes without exposing query data. */
function storageFailureMessage(cause: unknown): string | undefined {
  const seen = new Set<object>();
  for (let depth = 0; depth < 16 && typeof cause === "object" && cause !== null; depth++) {
    if (seen.has(cause)) break;
    seen.add(cause);
    const code = "code" in cause ? cause.code : undefined;
    const errcode = "errcode" in cause ? cause.errcode : undefined;
    const primaryCode = typeof errcode === "number" ? errcode & 0xff : undefined;
    const message = "message" in cause ? cause.message : undefined;
    if (
      code === "SQLITE_FULL" ||
      code === "ENOSPC" ||
      primaryCode === 13 ||
      message === "database or disk is full"
    ) {
      return "Solla's database or disk is full. Free disk space on the machine running Solla, then try again.";
    }
    if (
      code === "SQLITE_CANTOPEN" ||
      primaryCode === 14 ||
      message === "unable to open database file"
    ) {
      return "Solla couldn't open its database. Check free disk space and folder permissions on the machine running Solla, then try again.";
    }
    cause = "cause" in cause ? cause.cause : undefined;
  }
}

export class PersistenceSqlError extends Schema.TaggedErrorClass<PersistenceSqlError>()(
  "PersistenceSqlError",
  {
    operation: Schema.String,
    detail: Schema.optional(Schema.String),
    correlation: Schema.optional(PersistenceErrorCorrelation),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    const storageMessage = storageFailureMessage(this.cause);
    if (storageMessage !== undefined) return storageMessage;
    return this.detail === undefined
      ? `SQL error in ${this.operation}`
      : `SQL error in ${this.operation}: ${this.detail}`;
  }
}

export class PersistenceDecodeError extends Schema.TaggedErrorClass<PersistenceDecodeError>()(
  "PersistenceDecodeError",
  {
    operation: Schema.String,
    issue: Schema.String,
    correlation: Schema.optional(PersistenceErrorCorrelation),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  static fromSchemaError(
    operation: string,
    cause: Schema.SchemaError,
    correlation?: PersistenceErrorCorrelation,
  ): PersistenceDecodeError {
    return new PersistenceDecodeError({
      operation,
      issue: summarizeSchemaIssue(cause.issue),
      ...(correlation === undefined ? {} : { correlation }),
      cause,
    });
  }

  override get message(): string {
    return `Decode error in ${this.operation}: ${this.issue}`;
  }
}
const isPersistenceSqlError = Schema.is(PersistenceSqlError);
const isPersistenceDecodeError = Schema.is(PersistenceDecodeError);

// Kept for orchestration/projection call sites, which are being revamped separately.
export function toPersistenceSqlError(operation: string) {
  return (cause: unknown): PersistenceSqlError =>
    new PersistenceSqlError({
      operation,
      detail: `Failed to execute ${operation}`,
      cause,
    });
}

// Kept for orchestration/projection call sites, which are being revamped separately.
export function toPersistenceDecodeError(operation: string) {
  return (cause: Schema.SchemaError): PersistenceDecodeError =>
    PersistenceDecodeError.fromSchemaError(operation, cause);
}

export const isPersistenceError = (u: unknown) =>
  isPersistenceSqlError(u) || isPersistenceDecodeError(u);

export type OrchestrationEventStoreError = PersistenceSqlError | PersistenceDecodeError;

export type OrchestrationCommandReceiptRepositoryError =
  | PersistenceSqlError
  | PersistenceDecodeError;

export type ProviderSessionRuntimeRepositoryError = PersistenceSqlError | PersistenceDecodeError;
export type AuthPairingLinkRepositoryError = PersistenceSqlError | PersistenceDecodeError;
export type AuthSessionRepositoryError = PersistenceSqlError | PersistenceDecodeError;

export type ProjectionRepositoryError = PersistenceSqlError | PersistenceDecodeError;
