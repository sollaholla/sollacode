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

describe("codex node_repl computer control", () => {
  // Verbatim from a real Codex run (2026-09-01): the agent inspecting the Epic
  // Games launcher. This showed up in the work log as "Node_repl · js".
  const realSkyCode = [
    'globalThis.epicState = await sky.get_app_state({ app: "com.epicgames.EpicGamesLauncher", disableDiff: true });',
    'if (epicState.screenshot) await nodeRepl.emitImage({ bytes: await fsmod.readFile(urlmod.fileURLToPath(epicState.screenshot.url)), mimeType: "image/png" });',
    "nodeRepl.write(epicState.text);",
  ].join("\n");

  it("names the sky action instead of the repl transport", () => {
    expect(
      previewComputerControlAction({
        toolTitle: "node_repl · js",
        toolData: { server: "node_repl", tool: "js", arguments: { code: realSkyCode } },
      }),
    ).toBe("get app state");
  });

  it("shows the method and then the title codex wrote for the call", () => {
    // "Open Lyra project installer" is what the agent was actually doing;
    // the sky method it opens with is an implementation detail.
    expect(
      previewComputerControlAction({
        toolTitle: "node_repl · js",
        toolData: {
          server: "node_repl",
          tool: "js",
          arguments: { title: "Open Lyra project installer", code: realSkyCode },
        },
      }),
    ).toBe("get app state — Open Lyra project installer");
    // Action first, intent last: you can see it was a click, and what for.
    expect(previewComputerControlHeading("click — Open Lyra project installer")).toBe(
      "Computer control · Click — Open Lyra project installer",
    );
  });

  it("falls back to the method when the title is blank", () => {
    expect(
      previewComputerControlAction({
        toolData: {
          server: "node_repl",
          tool: "js",
          arguments: { title: "   ", code: realSkyCode },
        },
      }),
    ).toBe("get app state");
  });

  it("does not let a title alone claim computer control", () => {
    // No sky call means no computer control, however descriptive the title.
    expect(
      previewComputerControlAction({
        toolData: {
          server: "node_repl",
          tool: "js",
          arguments: { title: "Open Lyra project installer", code: "nodeRepl.write(1);" },
        },
      }),
    ).toBeNull();
  });

  it("reads the snake_case and camelCase spellings the same way", () => {
    const action = (code: string) =>
      previewComputerControlAction({
        toolData: { server: "node_repl", tool: "js", arguments: { code } },
      });
    expect(action('await sky.press_key({ key: "Enter" })')).toBe("press key");
    expect(action("await sky.perform_secondary_action({})")).toBe("perform secondary action");
    expect(action("await sky.getAppState({})")).toBe("get app state");
    expect(action("await sky.click({ x: 1, y: 2 })")).toBe("click");
  });

  it("leaves ordinary node_repl javascript alone", () => {
    // Not computer control: mislabeling this would claim the agent touched the
    // machine when it only did arithmetic.
    expect(
      previewComputerControlAction({
        toolTitle: "node_repl · js",
        toolData: {
          server: "node_repl",
          tool: "js",
          arguments: { code: "nodeRepl.write(1 + 1);" },
        },
      }),
    ).toBeNull();
    // A `sky` that is only imported, never called, is still not an action.
    expect(
      previewComputerControlAction({
        toolData: {
          server: "node_repl",
          tool: "js",
          arguments: { code: 'globalThis.sky = globalThis.sky || (await import("@oai/sky")).sky;' },
        },
      }),
    ).toBeNull();
    // Another server's tool that happens to run sky-shaped code is not ours.
    expect(
      previewComputerControlAction({
        toolData: { server: "other", tool: "js", arguments: { code: "await sky.click({})" } },
      }),
    ).toBeNull();
  });

  it("renders as a computer-control heading", () => {
    expect(previewComputerControlHeading("get app state")).toBe("Computer control · Get app state");
  });
});
