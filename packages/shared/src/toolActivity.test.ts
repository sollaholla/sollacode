import { describe, expect, it } from "vite-plus/test";

import { deriveToolActivityPresentation } from "./toolActivity.ts";

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
