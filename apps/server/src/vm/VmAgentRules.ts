import { type VmAgentId, type VmAgentRules } from "@t3tools/contracts";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";

export const VM_AGENT_RULES_FILE_NAME = "AGENTS.md";
export const VM_AGENT_CLAUDE_RULES_FILE_NAME = "CLAUDE.md";
export const VM_AGENT_CLAUDE_RULES_POINTER = "@AGENTS.md";
export const VM_AGENT_RULES_MAX_CHARACTERS = 100_000;
/**
 * Generated head of an oversized AGENTS.md. Claude imports whole files, so a
 * runaway AGENTS.md would put every fresh Claude session past its context
 * limit before the first message; CLAUDE.md imports this bounded copy instead.
 */
export const VM_AGENT_CLAUDE_LOADED_RULES_FILE_NAME = "AGENTS.loaded.md";
export const VM_AGENT_CLAUDE_LOADED_RULES_POINTER = "@AGENTS.loaded.md";

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
 * Make CLAUDE.md import exactly one rules file: `pointer`. The other Solla
 * import is swapped in place, Claude-specific instructions are preserved, and
 * a missing import is appended once as its own line.
 */
function withVmAgentClaudeRulesImport(content: string, pointer: string): string {
  const other =
    pointer === VM_AGENT_CLAUDE_RULES_POINTER
      ? VM_AGENT_CLAUDE_LOADED_RULES_POINTER
      : VM_AGENT_CLAUDE_RULES_POINTER;
  const lines = content.split("\n");
  const isImport = (line: string, target: string) => line.trim() === target;
  if (!lines.some((line) => isImport(line, other))) {
    if (lines.some((line) => isImport(line, pointer))) return content;
    if (content.length === 0) return `${pointer}\n`;
    const separator = content.endsWith("\n") ? "\n" : "\n\n";
    return `${content}${separator}${pointer}\n`;
  }
  let placed = lines.some((line) => isImport(line, pointer));
  return lines
    .flatMap((line) => {
      if (!isImport(line, other)) return [line];
      if (placed) return [];
      placed = true;
      return [line.replace(other, pointer)];
    })
    .join("\n");
}

/**
 * Keep AGENTS.md as the one editable rules source while making Claude load it.
 * Existing Claude-specific instructions are preserved and the import is added
 * at most once as its own line.
 */
export function ensureVmAgentClaudeRulesPointer(content: string): string {
  return withVmAgentClaudeRulesImport(content, VM_AGENT_CLAUDE_RULES_POINTER);
}

/**
 * The head of an AGENTS.md longer than `maxCharacters`, cut at a line break and
 * ending with a note that names the real size; `null` when the file fits.
 */
export function boundedVmAgentRules(
  content: string,
  maxCharacters = VM_AGENT_RULES_MAX_CHARACTERS,
): string | null {
  if (content.length <= maxCharacters) return null;
  const note = [
    "",
    "",
    `<!-- Solla Code: ${VM_AGENT_RULES_FILE_NAME} is ${content.length.toLocaleString("en-US")} characters, over the ${maxCharacters.toLocaleString("en-US")}-character budget. Only the text above is loaded. Compact ${VM_AGENT_RULES_FILE_NAME} and edit it, never this generated file. -->`,
    "",
  ].join("\n");
  const room = Math.max(0, maxCharacters - note.length);
  const lineBreak = content.lastIndexOf("\n", room);
  const head = content.slice(0, lineBreak > room / 2 ? lineBreak : room);
  return `${head}${note}`;
}

export interface VmAgentRulesOverflow {
  /** Length of the agent's AGENTS.md. */
  readonly characters: number;
  /** How much of it Claude now loads. */
  readonly loadedCharacters: number;
}

/**
 * Keep Claude's view of an agent's AGENTS.md within budget. Run before a
 * session starts and before each turn: an oversized file gets a generated
 * bounded head that CLAUDE.md imports instead, and a file back under budget
 * gets its full import restored. A CLAUDE.md that imports neither is the
 * agent's own choice and is left alone. Returns the overflow, or `null`.
 */
export const boundVmAgentClaudeRules = Effect.fn("VmAgentRules.boundClaudeRules")(
  function* (input: {
    readonly fileSystem: FileSystem.FileSystem;
    readonly path: Path.Path;
    readonly workspaceDir: string;
    readonly maxCharacters?: number;
  }) {
    const maxCharacters = input.maxCharacters ?? VM_AGENT_RULES_MAX_CHARACTERS;
    const rulesPath = input.path.join(input.workspaceDir, VM_AGENT_RULES_FILE_NAME);
    const claudeRulesPath = input.path.join(input.workspaceDir, VM_AGENT_CLAUDE_RULES_FILE_NAME);
    const loadedRulesPath = input.path.join(
      input.workspaceDir,
      VM_AGENT_CLAUDE_LOADED_RULES_FILE_NAME,
    );
    const rulesInfo = yield* input.fileSystem
      .stat(rulesPath)
      .pipe(Effect.orElseSucceed(() => null));
    // Bytes never undercount characters, so a small file needs no read.
    const rules =
      rulesInfo === null || Number(rulesInfo.size) <= maxCharacters
        ? null
        : yield* input.fileSystem.readFileString(rulesPath);
    const bounded = rules === null ? null : boundedVmAgentRules(rules, maxCharacters);

    if (bounded !== null) {
      const previous = yield* input.fileSystem
        .readFileString(loadedRulesPath)
        .pipe(Effect.orElseSucceed(() => null));
      if (previous !== bounded) {
        yield* input.fileSystem.writeFileString(loadedRulesPath, bounded);
      }
    }
    const claudeRules = yield* input.fileSystem
      .readFileString(claudeRulesPath)
      .pipe(Effect.orElseSucceed(() => null));
    const importsRules =
      claudeRules !== null &&
      claudeRules
        .split("\n")
        .some(
          (line) =>
            line.trim() === VM_AGENT_CLAUDE_RULES_POINTER ||
            line.trim() === VM_AGENT_CLAUDE_LOADED_RULES_POINTER,
        );
    if (claudeRules !== null && importsRules) {
      const nextClaudeRules = withVmAgentClaudeRulesImport(
        claudeRules,
        bounded === null ? VM_AGENT_CLAUDE_RULES_POINTER : VM_AGENT_CLAUDE_LOADED_RULES_POINTER,
      );
      if (nextClaudeRules !== claudeRules) {
        yield* input.fileSystem.writeFileString(claudeRulesPath, nextClaudeRules);
      }
    }
    if (bounded === null) {
      yield* input.fileSystem.remove(loadedRulesPath, { force: true });
      return null;
    }
    return {
      characters: rules?.length ?? 0,
      loadedCharacters: bounded.length,
    } satisfies VmAgentRulesOverflow;
  },
);

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
