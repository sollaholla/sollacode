import { VmAgentId } from "@t3tools/contracts";
import { NodeFileSystem, NodePath } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import {
  boundedVmAgentRules,
  boundVmAgentClaudeRules,
  ensureVmAgentClaudeRulesPointer,
  readVmAgentRulesFile,
  resolveVmAgentRulesPath,
  VM_AGENT_CLAUDE_LOADED_RULES_POINTER,
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

  it("cuts an oversized AGENTS.md at a line break and names its real size", () => {
    expect(boundedVmAgentRules("short\n", 1_000)).toBeNull();
    const content = Array.from({ length: 200 }, (_, index) => `line ${index}`).join("\n");
    const bounded = boundedVmAgentRules(content, 600);
    expect(bounded).not.toBeNull();
    expect(bounded!.length).toBeLessThanOrEqual(600);
    expect(content.startsWith(bounded!.slice(0, bounded!.indexOf("\n\n<!--")))).toBe(true);
    expect(bounded).toMatch(/line \d+\n\n<!-- Solla Code: AGENTS\.md is 1,689 characters/);
  });

  it("swaps between the full and bounded imports in place, keeping other lines", () => {
    const full = `# Claude-only\n${VM_AGENT_CLAUDE_RULES_POINTER}\n# After\n`;
    const loaded = `# Claude-only\n${VM_AGENT_CLAUDE_LOADED_RULES_POINTER}\n# After\n`;
    expect(ensureVmAgentClaudeRulesPointer(loaded)).toBe(full);
    expect(
      ensureVmAgentClaudeRulesPointer(
        `${VM_AGENT_CLAUDE_RULES_POINTER}\n${VM_AGENT_CLAUDE_LOADED_RULES_POINTER}\n`,
      ),
    ).toBe(`${VM_AGENT_CLAUDE_RULES_POINTER}\n`);
  });

  it.effect(
    "imports a bounded head while AGENTS.md is oversized and restores the full import",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const workspace = yield* fileSystem.makeTempDirectoryScoped();
        const rulesPath = path.join(workspace, "AGENTS.md");
        const claudeRulesPath = path.join(workspace, "CLAUDE.md");
        const loadedRulesPath = path.join(workspace, "AGENTS.loaded.md");
        const claudeRules = `# Claude-only\n\n${VM_AGENT_CLAUDE_RULES_POINTER}\n`;
        yield* fileSystem.writeFileString(claudeRulesPath, claudeRules);
        yield* fileSystem.writeFileString(rulesPath, "# Rules\n");
        const bound = (maxCharacters: number) =>
          boundVmAgentClaudeRules({ fileSystem, path, workspaceDir: workspace, maxCharacters });

        expect(yield* bound(1_000)).toBeNull();
        expect(yield* fileSystem.readFileString(claudeRulesPath)).toBe(claudeRules);
        expect(yield* fileSystem.exists(loadedRulesPath)).toBe(false);

        const oversized = "# Rules\n" + "remember this\n".repeat(200);
        yield* fileSystem.writeFileString(rulesPath, oversized);
        const overflow = yield* bound(1_000);
        expect(overflow).toEqual({
          characters: oversized.length,
          loadedCharacters: (yield* fileSystem.readFileString(loadedRulesPath)).length,
        });
        expect(overflow!.loadedCharacters).toBeLessThanOrEqual(1_000);
        expect(yield* fileSystem.readFileString(claudeRulesPath)).toBe(
          `# Claude-only\n\n${VM_AGENT_CLAUDE_LOADED_RULES_POINTER}\n`,
        );
        // The agent's own file is never rewritten.
        expect(yield* fileSystem.readFileString(rulesPath)).toBe(oversized);

        yield* fileSystem.writeFileString(rulesPath, "# Compacted\n");
        expect(yield* bound(1_000)).toBeNull();
        expect(yield* fileSystem.readFileString(claudeRulesPath)).toBe(claudeRules);
        expect(yield* fileSystem.exists(loadedRulesPath)).toBe(false);
      }).pipe(Effect.provide(Layer.merge(NodeFileSystem.layer, NodePath.layer)), Effect.scoped),
  );

  it.effect("leaves a CLAUDE.md that imports neither rules file alone", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const workspace = yield* fileSystem.makeTempDirectoryScoped();
      yield* fileSystem.writeFileString(path.join(workspace, "CLAUDE.md"), "# Own rules\n");
      yield* fileSystem.writeFileString(path.join(workspace, "AGENTS.md"), "x".repeat(2_000));
      expect(
        yield* boundVmAgentClaudeRules({
          fileSystem,
          path,
          workspaceDir: workspace,
          maxCharacters: 1_000,
        }),
      ).not.toBeNull();
      expect(yield* fileSystem.readFileString(path.join(workspace, "CLAUDE.md"))).toBe(
        "# Own rules\n",
      );
    }).pipe(Effect.provide(Layer.merge(NodeFileSystem.layer, NodePath.layer)), Effect.scoped),
  );
});
