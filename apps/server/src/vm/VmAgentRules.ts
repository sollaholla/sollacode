import { type VmAgentId, type VmAgentRules } from "@t3tools/contracts";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";

export const VM_AGENT_RULES_FILE_NAME = "AGENTS.md";
export const VM_AGENT_CLAUDE_RULES_FILE_NAME = "CLAUDE.md";
export const VM_AGENT_CLAUDE_RULES_POINTER = "@AGENTS.md";
export const VM_AGENT_RULES_MAX_CHARACTERS = 100_000;

export class VmAgentRulesFileError extends Data.TaggedError("VmAgentRulesFileError")<{
  readonly operation: "read" | "write";
  readonly detail: string;
}> {}

/**
 * Resolve the one rules file agents may edit. Agent threads must use a
 * dedicated child of the configured agents root; a legacy shared root or an
 * escaped/external path fails closed instead of exposing an arbitrary file.
 */
export function resolveVmAgentRulesPath(
  path: Path.Path,
  agentsWorkspaceDir: string,
  worktreePath: string,
): string | null {
  const root = path.resolve(agentsWorkspaceDir);
  const workspace = path.resolve(worktreePath);
  const relative = path.relative(root, workspace);
  if (
    relative.length === 0 ||
    path.isAbsolute(relative) ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    /^\.\.[\\/]/.test(relative)
  ) {
    return null;
  }
  return path.join(workspace, VM_AGENT_RULES_FILE_NAME);
}

/**
 * Keep AGENTS.md as the one editable rules source while making Claude load it.
 * Existing Claude-specific instructions are preserved and the import is added
 * at most once as its own line.
 */
export function ensureVmAgentClaudeRulesPointer(content: string): string {
  if (content.split(/\r?\n/u).some((line) => line.trim() === VM_AGENT_CLAUDE_RULES_POINTER)) {
    return content;
  }
  if (content.length === 0) return `${VM_AGENT_CLAUDE_RULES_POINTER}\n`;
  const separator = content.endsWith("\n") ? "\n" : "\n\n";
  return `${content}${separator}${VM_AGENT_CLAUDE_RULES_POINTER}\n`;
}

export const readVmAgentRulesFile = Effect.fn("VmAgentRules.readFile")(function* (input: {
  readonly fileSystem: FileSystem.FileSystem;
  readonly rulesPath: string;
  readonly vmAgentId: VmAgentId;
}) {
  const exists = yield* input.fileSystem
    .exists(input.rulesPath)
    .pipe(
      Effect.mapError(
        (error) => new VmAgentRulesFileError({ operation: "read", detail: String(error.message) }),
      ),
    );
  if (!exists) {
    return {
      vmAgentId: input.vmAgentId,
      fileName: VM_AGENT_RULES_FILE_NAME,
      content: "",
      exists: false,
    } satisfies VmAgentRules;
  }

  const content = yield* input.fileSystem
    .readFileString(input.rulesPath)
    .pipe(
      Effect.mapError(
        (error) => new VmAgentRulesFileError({ operation: "read", detail: String(error.message) }),
      ),
    );
  if (content.length > VM_AGENT_RULES_MAX_CHARACTERS) {
    return yield* new VmAgentRulesFileError({
      operation: "read",
      detail: `${VM_AGENT_RULES_FILE_NAME} exceeds ${VM_AGENT_RULES_MAX_CHARACTERS.toLocaleString()} characters`,
    });
  }
  return {
    vmAgentId: input.vmAgentId,
    fileName: VM_AGENT_RULES_FILE_NAME,
    content,
    exists: true,
  } satisfies VmAgentRules;
});

export const writeVmAgentRulesFile = Effect.fn("VmAgentRules.writeFile")(function* (input: {
  readonly claudeRulesPath: string;
  readonly content: string;
  readonly fileSystem: FileSystem.FileSystem;
  readonly rulesPath: string;
  readonly vmAgentId: VmAgentId;
}) {
  if (input.content.length > VM_AGENT_RULES_MAX_CHARACTERS) {
    return yield* new VmAgentRulesFileError({
      operation: "write",
      detail: `${VM_AGENT_RULES_FILE_NAME} exceeds ${VM_AGENT_RULES_MAX_CHARACTERS.toLocaleString()} characters`,
    });
  }
  const readPrevious = (filePath: string) =>
    Effect.gen(function* () {
      const exists = yield* input.fileSystem.exists(filePath);
      return {
        exists,
        content: exists ? yield* input.fileSystem.readFileString(filePath) : "",
      };
    });
  const [previousRules, previousClaude] = yield* Effect.all([
    readPrevious(input.rulesPath),
    readPrevious(input.claudeRulesPath),
  ]).pipe(
    Effect.mapError(
      (error) => new VmAgentRulesFileError({ operation: "write", detail: String(error.message) }),
    ),
  );
  const nextClaude = ensureVmAgentClaudeRulesPointer(previousClaude.content);

  yield* input.fileSystem
    .writeFileString(input.rulesPath, input.content)
    .pipe(
      Effect.mapError(
        (error) => new VmAgentRulesFileError({ operation: "write", detail: String(error.message) }),
      ),
    );
  const pointerWriteError = yield* input.fileSystem
    .writeFileString(input.claudeRulesPath, nextClaude)
    .pipe(
      Effect.as<string | null>(null),
      Effect.catch((error) => Effect.succeed(String(error.message))),
    );
  if (pointerWriteError !== null) {
    const restore = (
      filePath: string,
      previous: { readonly exists: boolean; readonly content: string },
    ) =>
      (previous.exists
        ? input.fileSystem.writeFileString(filePath, previous.content)
        : input.fileSystem.remove(filePath, { force: true })
      ).pipe(
        Effect.as<string | null>(null),
        Effect.catch((error) => Effect.succeed(String(error.message))),
      );
    const [rulesRollbackError, claudeRollbackError] = yield* Effect.all([
      restore(input.rulesPath, previousRules),
      restore(input.claudeRulesPath, previousClaude),
    ]);
    const rollbackErrors = [rulesRollbackError, claudeRollbackError].filter(
      (detail): detail is string => detail !== null,
    );
    return yield* new VmAgentRulesFileError({
      operation: "write",
      detail:
        rollbackErrors.length === 0
          ? `Could not update ${VM_AGENT_CLAUDE_RULES_FILE_NAME}: ${pointerWriteError}`
          : `Could not update ${VM_AGENT_CLAUDE_RULES_FILE_NAME}: ${pointerWriteError}. Rollback also failed: ${rollbackErrors.join("; ")}`,
    });
  }
  return {
    vmAgentId: input.vmAgentId,
    fileName: VM_AGENT_RULES_FILE_NAME,
    content: input.content,
    exists: true,
  } satisfies VmAgentRules;
});
