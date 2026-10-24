import type { OrchestrationThreadActivity } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { readImageToolOutputPath } from "@t3tools/shared/filePreview";
import { activityAuthorizesExternalImagePath } from "../assets/ThreadAssetAuthorization.ts";

import {
  MCP_RESULT_STRING_MAX_CHARS,
  projectActivityPayload,
} from "./ActivityPayloadProjection.ts";

const mcpActivity = (item: Record<string, unknown>): OrchestrationThreadActivity =>
  ({
    id: "activity-1",
    tone: "tool",
    kind: "tool.completed",
    summary: "MCP tool call complete",
    turnId: "turn-1",
    createdAt: "2026-09-30T00:00:00.000Z",
    payload: { itemType: "mcp_tool_call", data: { toolCallId: "call-1", item } },
  }) as unknown as OrchestrationThreadActivity;

const itemOf = (activity: OrchestrationThreadActivity) =>
  ((activity.payload as { data: { item: Record<string, unknown> } }).data.item ?? {}) as Record<
    string,
    unknown
  >;

describe("projectActivityPayload for image previews", () => {
  const path = "/workspace/agents/project/evidence/native-capture/eye-forward-00.png";

  it.each([
    { item: { type: "imageView", path } },
    { item: { type: "imageGeneration", savedPath: path } },
    { toolName: "ReadImage", params: path },
  ])("keeps the full viewed image available after projection: %j", (data) => {
    const activity = {
      ...mcpActivity({}),
      summary: "Image view",
      payload: {
        itemType: "image_view",
        title: "Image view",
        detail: path.slice(0, 40) + "...",
        data,
      },
    };
    const projected = projectActivityPayload(activity);
    expect(readImageToolOutputPath(projected.payload)).toBe(path);
    expect(readImageToolOutputPath(projectActivityPayload(projected).payload)).toBe(path);
    expect(activityAuthorizesExternalImagePath(activity, path)).toBe(true);
    expect(activityAuthorizesExternalImagePath(projected, path)).toBe(true);
    expect(activityAuthorizesExternalImagePath(projected, "/workspace/unrelated.png")).toBe(false);
  });
});

describe("projectActivityPayload for MCP tool calls", () => {
  it("drops structuredContent when content already carries the same result", () => {
    const projected = projectActivityPayload(
      mcpActivity({
        server: "t3-code",
        tool: "preview_status",
        result: {
          content: [{ type: "text", text: '{"url":"https://example.com"}' }],
          structuredContent: { url: "https://example.com" },
        },
      }),
    );
    expect(itemOf(projected).result).toEqual({
      content: [{ type: "text", text: '{"url":"https://example.com"}' }],
    });
  });

  it("keeps structuredContent when there is no content to stand in for it", () => {
    const result = { structuredContent: { ok: true } };
    const activity = mcpActivity({ server: "s", tool: "t", result });
    expect(projectActivityPayload(activity)).toBe(activity);
  });

  it("cuts long result text and says how much was left out", () => {
    const text = "x".repeat(MCP_RESULT_STRING_MAX_CHARS + 500);
    const projected = projectActivityPayload(
      mcpActivity({ server: "s", tool: "t", result: { content: [{ type: "text", text }] } }),
    );
    const [block] = (itemOf(projected).result as { content: Array<{ text: string }> }).content;
    expect(block!.text.startsWith("x".repeat(MCP_RESULT_STRING_MAX_CHARS))).toBe(true);
    expect(block!.text).toContain("500 more characters not shown");
    expect(block!.text.length).toBeLessThan(MCP_RESULT_STRING_MAX_CHARS + 60);
  });

  it("does not split a surrogate pair at the cut", () => {
    const text = `${"a".repeat(MCP_RESULT_STRING_MAX_CHARS - 1)}😀${"b".repeat(50)}`;
    const projected = projectActivityPayload(
      mcpActivity({ server: "s", tool: "t", result: { content: [{ type: "text", text }] } }),
    );
    const [block] = (itemOf(projected).result as { content: Array<{ text: string }> }).content;
    expect(block!.text).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/u);
  });

  it("leaves image data, arguments, and short results exactly as sent", () => {
    const base64 = "A".repeat(MCP_RESULT_STRING_MAX_CHARS * 3);
    const longCode = "tab.goto('x');".repeat(1_500);
    const activity = mcpActivity({
      server: "node_repl",
      tool: "js",
      arguments: { code: longCode, title: "Open page" },
      result: { content: [{ type: "image", mimeType: "image/png", data: base64 }] },
    });
    const projected = projectActivityPayload(activity);
    expect(projected).toBe(activity);
    expect(itemOf(projected).arguments).toEqual({ code: longCode, title: "Open page" });
  });

  it("returns the same activity when there is nothing to trim", () => {
    const activity = mcpActivity({
      server: "t3-code",
      tool: "preview_click",
      result: { content: [{ type: "text", text: "ok" }] },
    });
    expect(projectActivityPayload(activity)).toBe(activity);
  });

  it("does not change what the shared control detection reads", () => {
    const projected = projectActivityPayload(
      mcpActivity({
        server: "t3-code",
        tool: "preview_navigate",
        arguments: { url: "https://example.com" },
        status: "completed",
        result: {
          content: [{ type: "text", text: "y".repeat(20_000) }],
          structuredContent: { big: "z".repeat(20_000) },
        },
      }),
    );
    const item = itemOf(projected);
    expect(item.server).toBe("t3-code");
    expect(item.tool).toBe("preview_navigate");
    expect(item.arguments).toEqual({ url: "https://example.com" });
    expect(item.status).toBe("completed");
  });
});
