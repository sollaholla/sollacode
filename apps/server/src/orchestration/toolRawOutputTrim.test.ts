import { assert, describe, it } from "@effect/vitest";

import {
  STORED_TOOL_RAW_OUTPUT_MAX_CHARS,
  toolCallIdOfToolActivityPayload,
  trimActivityToolRawOutputForStorage,
  trimToolRawOutputInPayload,
} from "./toolRawOutputTrim.ts";

describe("trimToolRawOutputInPayload", () => {
  it("caps oversized strings anywhere inside rawOutput and nothing else", () => {
    const payload = {
      detail: "d".repeat(64),
      data: {
        toolCallId: "call-1",
        content: "rendered by clients ".repeat(50),
        rawOutput: {
          content: "x".repeat(100),
          FileContent: { content: "y".repeat(150), nested: ["z".repeat(120), 7, null] },
        },
      },
    };

    const result = trimToolRawOutputInPayload(payload, 100);
    assert.isTrue(result.changed);
    const next = result.payload as typeof payload;
    assert.equal(next.data.rawOutput.content.length, 100);
    assert.equal(next.data.rawOutput.FileContent.content.length, 100);
    assert.deepEqual(next.data.rawOutput.FileContent.nested, ["z".repeat(100), 7, null]);
    // Everything outside rawOutput is rendered by clients and stays whole.
    assert.equal(next.data.content, payload.data.content);
    assert.equal(next.detail, payload.detail);
    assert.equal(next.data.toolCallId, "call-1");
    // The input is never mutated.
    assert.equal(payload.data.rawOutput.content.length, 100);
    assert.equal(payload.data.rawOutput.FileContent.content.length, 150);
  });

  it("caps a rawOutput that is one bare oversized string", () => {
    const payload = { data: { rawOutput: "y".repeat(64) } };
    const result = trimToolRawOutputInPayload(payload, 16);
    assert.isTrue(result.changed);
    assert.equal(
      (result.payload as { data: { rawOutput: string } }).data.rawOutput,
      "y".repeat(16),
    );
  });

  it("caps strings inside an MCP item result and keeps arguments whole", () => {
    const payload = {
      data: {
        item: {
          type: "mcpToolCall",
          server: "t3-code",
          tool: "preview_snapshot",
          arguments: { note: "a".repeat(200) },
          result: {
            content: [{ type: "text", text: "b".repeat(300) }],
            screenshot: "c".repeat(400),
          },
        },
      },
    };
    const result = trimToolRawOutputInPayload(payload, 100);
    assert.isTrue(result.changed);
    const item = (
      result.payload as {
        data: {
          item: {
            arguments: { note: string };
            result: { content: Array<{ text: string }>; screenshot: string };
            server: string;
          };
        };
      }
    ).data.item;
    assert.equal(item.result.content[0]?.text.length, 100);
    assert.equal(item.result.screenshot.length, 100);
    assert.equal(item.arguments.note.length, 200);
    assert.equal(item.server, "t3-code");
    // The input is never mutated.
    assert.equal(payload.data.item.result.screenshot.length, 400);
  });

  it("returns the identical payload when nothing exceeds the cap", () => {
    const payload = {
      data: { rawOutput: { content: "short" }, item: { result: { text: "ok" } } },
    };
    const result = trimToolRawOutputInPayload(payload, 100);
    assert.isFalse(result.changed);
    assert.equal(result.payload, payload);
  });

  it("leaves payloads without trimmable subtrees untouched", () => {
    for (const payload of [
      null,
      "text",
      { data: null },
      { data: { rawOutput: null } },
      { data: { item: null } },
      { data: { item: { result: null } } },
      { noData: true },
    ]) {
      const result = trimToolRawOutputInPayload(payload, 4);
      assert.isFalse(result.changed);
      assert.equal(result.payload, payload);
    }
  });
});

describe("trimActivityToolRawOutputForStorage", () => {
  it("caps at the storage limit and preserves identity when unchanged", () => {
    const oversized = {
      kind: "tool.completed",
      payload: {
        data: { rawOutput: { content: "x".repeat(STORED_TOOL_RAW_OUTPUT_MAX_CHARS + 10) } },
      },
    };
    const trimmed = trimActivityToolRawOutputForStorage(oversized);
    assert.notEqual(trimmed, oversized);
    const trimmedPayload = trimmed.payload as { data: { rawOutput: { content: string } } };
    assert.equal(trimmedPayload.data.rawOutput.content.length, STORED_TOOL_RAW_OUTPUT_MAX_CHARS);

    const small = { kind: "tool.completed", payload: { data: { rawOutput: { content: "ok" } } } };
    assert.equal(trimActivityToolRawOutputForStorage(small), small);
  });
});

describe("toolCallIdOfToolActivityPayload", () => {
  it("extracts a non-empty string id and rejects everything else", () => {
    assert.equal(toolCallIdOfToolActivityPayload({ data: { toolCallId: "call-9" } }), "call-9");
    assert.isNull(toolCallIdOfToolActivityPayload({ data: { toolCallId: "" } }));
    assert.isNull(toolCallIdOfToolActivityPayload({ data: { toolCallId: 7 } }));
    assert.isNull(toolCallIdOfToolActivityPayload({ data: {} }));
    assert.isNull(toolCallIdOfToolActivityPayload({}));
    assert.isNull(toolCallIdOfToolActivityPayload(null));
  });
});
