import { VmAgentId } from "@t3tools/contracts";
import { NodeFileSystem, NodePath } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import {
  ensureVmAgentClaudeRulesPointer,
  readVmAgentRulesFile,
  resolveVmAgentRulesPath,
  VM_AGENT_CLAUDE_RULES_POINTER,
  writeVmAgentRulesFile,
} from "./VmAgentRules.ts";

describe("VmAgentRules", () => {
  it.effect("only resolves dedicated working directories below the agents root", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      expect(resolveVmAgentRulesPath(path, "/agents", "/agents/pawstalgia-123")).toBe(
        path.join("/agents/pawstalgia-123", "AGENTS.md"),
      );
      expect(resolveVmAgentRulesPath(path, "/agents", "/agents")).toBeNull();
      expect(resolveVmAgentRulesPath(path, "/agents", "/outside/pawstalgia")).toBeNull();
      expect(resolveVmAgentRulesPath(path, "/agents", "/agents/../escape")).toBeNull();
    }).pipe(Effect.provide(NodePath.layer)),
  );

  it("adds one AGENTS.md pointer without replacing Claude-specific instructions", () => {
    expect(ensureVmAgentClaudeRulesPointer("")).toBe(`${VM_AGENT_CLAUDE_RULES_POINTER}\n`);
    const existing = "# Claude-only notes\n\nUse the shared profile.\n";
    const withPointer = ensureVmAgentClaudeRulesPointer(existing);
    expect(withPointer).toBe(`${existing}\n${VM_AGENT_CLAUDE_RULES_POINTER}\n`);
    expect(ensureVmAgentClaudeRulesPointer(withPointer)).toBe(withPointer);
  });

  it.effect("reads an absent file as an empty editor and persists updates", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const temporaryDirectory = yield* fileSystem.makeTempDirectoryScoped();
      const workspace = path.join(temporaryDirectory, "agent");
      yield* fileSystem.makeDirectory(workspace, { recursive: true });
      const rulesPath = path.join(workspace, "AGENTS.md");
      const claudeRulesPath = path.join(workspace, "CLAUDE.md");
      const vmAgentId = VmAgentId.make("agent-1");

      expect(yield* readVmAgentRulesFile({ fileSystem, rulesPath, vmAgentId })).toMatchObject({
        content: "",
        exists: false,
      });

      const saved = yield* writeVmAgentRulesFile({
        claudeRulesPath,
        content: "# Pawstalgia\n\nReuse browser tabs.\n",
        fileSystem,
        rulesPath,
        vmAgentId,
      });
      expect(saved.exists).toBe(true);
      expect((yield* readVmAgentRulesFile({ fileSystem, rulesPath, vmAgentId })).content).toBe(
        saved.content,
      );
      expect(yield* fileSystem.readFileString(claudeRulesPath)).toBe(
        `${VM_AGENT_CLAUDE_RULES_POINTER}\n`,
      );

      yield* fileSystem.writeFileString(claudeRulesPath, "# Claude-only\n");
      yield* writeVmAgentRulesFile({
        claudeRulesPath,
        content: "# Updated rules\n",
        fileSystem,
        rulesPath,
        vmAgentId,
      });
      expect(yield* fileSystem.readFileString(claudeRulesPath)).toBe(
        `# Claude-only\n\n${VM_AGENT_CLAUDE_RULES_POINTER}\n`,
      );
    }).pipe(Effect.provide(Layer.merge(NodeFileSystem.layer, NodePath.layer)), Effect.scoped),
  );
});
