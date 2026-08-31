import { describe, expect, it } from "vite-plus/test";

import {
  previewComputerControlAction,
  previewComputerControlHeading,
} from "./previewComputerControl.ts";

describe("previewComputerControlAction", () => {
  it("detects a codex mcpToolCall item", () => {
    expect(
      previewComputerControlAction({
        toolData: { type: "mcpToolCall", server: "t3-code", tool: "preview_click" },
      }),
    ).toBe("click");
  });

  it("detects a composed server · tool title in any casing", () => {
    expect(previewComputerControlAction({ toolTitle: "t3-code · preview_evaluate" })).toBe(
      "evaluate",
    );
    expect(previewComputerControlAction({ toolTitle: "T3-code · preview_wait_for_download" })).toBe(
      "wait for download",
    );
  });

  it("detects a raw mcp__ tool name used as the title", () => {
    expect(previewComputerControlAction({ toolTitle: "mcp__t3-code__preview_snapshot" })).toBe(
      "snapshot",
    );
  });

  it("ignores everything that is not a t3-code preview tool", () => {
    expect(previewComputerControlAction({ toolTitle: "MCP tool call" })).toBeNull();
    expect(
      previewComputerControlAction({ toolTitle: "t3-code · thread_history_query" }),
    ).toBeNull();
    expect(previewComputerControlAction({ toolTitle: "other-server · preview_click" })).toBeNull();
    expect(
      previewComputerControlAction({
        toolData: { server: "github", tool: "preview_click" },
      }),
    ).toBeNull();
    expect(previewComputerControlAction({})).toBeNull();
  });
});

describe("previewComputerControlHeading", () => {
  it("prefixes the capitalized action with the label", () => {
    expect(previewComputerControlHeading("click")).toBe("Computer control · Click");
    expect(previewComputerControlHeading("wait for download")).toBe(
      "Computer control · Wait for download",
    );
  });
});
