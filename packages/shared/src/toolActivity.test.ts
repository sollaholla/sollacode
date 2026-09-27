import { describe, expect, it } from "vite-plus/test";

import { deriveToolActivityPresentation, normalizeOpenCodeToolPayload } from "./toolActivity.ts";

describe("OpenCode tool payloads", () => {
  it.each([
    [0, "passed", "completed"],
    [1, "test failed", "failed"],
    [0, "BUILD OK\n  FAILED [Fail] PressureInvariants", "completed"],
  ])("keeps command and outcome for exit %s and output %s", (exit, output, status) => {
    const state = {
      status: "completed",
      input: { command: "run-tests" },
      metadata: { exit },
      output,
    };
    const payload = normalizeOpenCodeToolPayload({ data: { tool: "bash", state } });
    expect(payload).toMatchObject({ status, data: { command: "run-tests", state } });
    expect(payload.data.state).toBe(state);
  });

  it("extracts edit paths without duplicating the edit body", () => {
    const state = {
      status: "completed",
      input: { filePath: "/project/src/model.ts", oldString: "before", newString: "after" },
      output: "Edit applied successfully.",
    };
    expect(normalizeOpenCodeToolPayload({ data: { tool: "edit", state } })).toEqual({
      status: "completed",
      data: { tool: "edit", state, changes: [{ path: "/project/src/model.ts" }] },
    });
  });

  it("retains explicit tool errors and extracts multiple patch paths", () => {
    expect(
      normalizeOpenCodeToolPayload({
        data: {
          tool: "apply_patch",
          state: {
            status: "error",
            input: {},
            metadata: { files: [{ filePath: "/project/a.ts" }, { filePath: "/project/b.ts" }] },
          },
        },
      }),
    ).toMatchObject({
      status: "failed",
      data: { changes: [{ path: "/project/a.ts" }, { path: "/project/b.ts" }] },
    });
  });

  it("preserves other provider payloads and pending OpenCode tool status", () => {
    const other = { data: { item: { command: "run-tests" } } };
    expect(normalizeOpenCodeToolPayload(other)).toBe(other);
    expect(
      normalizeOpenCodeToolPayload({
        data: { tool: "bash", state: { status: "running", input: { command: "run-tests" } } },
      }),
    ).toMatchObject({ status: "inProgress" });
  });
});

describe("toolActivity", () => {
  it("names t3-code preview MCP calls as computer control", () => {
    expect(
      deriveToolActivityPresentation({
        itemType: "mcp_tool_call",
        title:
          'mcp__t3-code__preview_evaluate:{"expression":"() => document.querySelector(\\".Download\\")"}',
      }),
    ).toEqual({
      summary: "Computer control · Evaluate",
    });
    expect(
      deriveToolActivityPresentation({
        itemType: "dynamic_tool_call",
        title: "mcp__t3-code__preview_snapshot",
      }),
    ).toEqual({
      summary: "Computer control · Snapshot",
    });
  });

  it("normalizes command tools to a stable ran-command label", () => {
    expect(
      deriveToolActivityPresentation({
        itemType: "command_execution",
        title: "Terminal",
        detail: "Terminal",
        data: {
          command: "bun run lint",
        },
        fallbackSummary: "Terminal",
      }),
    ).toEqual({
      summary: "Ran command",
      detail: "bun run lint",
    });
  });

  it("uses structured file paths for read-file tools when available", () => {
    expect(
      deriveToolActivityPresentation({
        itemType: "dynamic_tool_call",
        title: "Read File",
        detail: "Read File",
        data: {
          kind: "read",
          locations: [{ path: "/tmp/app.ts" }],
        },
        fallbackSummary: "Read File",
      }),
    ).toEqual({
      summary: "Read file",
      detail: "/tmp/app.ts",
    });
  });

  it("drops duplicated generic read-file detail when no path is available", () => {
    expect(
      deriveToolActivityPresentation({
        itemType: "dynamic_tool_call",
        title: "Read File",
        detail: "Read File",
        data: {
          kind: "read",
          rawInput: {},
        },
        fallbackSummary: "Read File",
      }),
    ).toEqual({
      summary: "Read file",
    });
  });

  it("replaces a generic Tool title using kind, path, and declared tool name", () => {
    expect(
      deriveToolActivityPresentation({
        itemType: "dynamic_tool_call",
        title: "Tool",
        fallbackSummary: "Tool",
        data: {
          kind: "other",
          rawInput: { path: "/tmp/app.ts" },
        },
      }),
    ).toEqual({
      summary: "Read file",
      detail: "/tmp/app.ts",
    });

    expect(
      deriveToolActivityPresentation({
        title: "Tool",
        fallbackSummary: "Tool",
        data: {
          kind: "other",
          command: "rg --files apps/web",
        },
      }),
    ).toEqual({
      summary: "Ran command",
      detail: "rg --files apps/web",
    });

    expect(
      deriveToolActivityPresentation({
        title: "Tool",
        fallbackSummary: "Tool",
        data: {
          kind: "other",
          rawInput: { name: "grep", pattern: "deriveWorkLogEntries" },
        },
      }),
    ).toEqual({
      summary: "Grep",
      detail: "deriveWorkLogEntries",
    });
  });
});
