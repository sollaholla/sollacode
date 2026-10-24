// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { externalizeSnapshotImages, storeSnapshotImages } from "./snapshotImageAttachments.ts";

const jpeg = "/9j/2Q==";
const codexSnapshot = {
  itemType: "mcp_tool_call",
  title: "t3-code · preview_snapshot",
  data: {
    item: {
      server: "t3-code",
      tool: "preview_snapshot",
      result: {
        content: [
          { type: "text", text: '{"url":"https://example.com"}' },
          { type: "image", data: jpeg, mimeType: "image/jpeg" },
        ],
      },
    },
  },
};

describe("externalizeSnapshotImages", () => {
  it("moves a Codex snapshot's picture into a file named by its bytes", () => {
    const moved = externalizeSnapshotImages({
      payload: codexSnapshot,
      summary: "t3-code · preview_snapshot",
      threadId: "Thread-1",
    });
    assert.isNotNull(moved);
    const [file] = moved!.files;
    assert.match(file!.relativePath, /^thread-1-[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}\.jpg$/u);
    assert.deepEqual([...file!.bytes], [0xff, 0xd8, 0xff, 0xd9]);
    const content = (moved!.payload as typeof codexSnapshot).data.item.result.content;
    // The text the client reads stays; the picture becomes a reference.
    assert.deepEqual(content[0], codexSnapshot.data.item.result.content[0]);
    assert.deepEqual(content[1] as unknown, {
      type: "image",
      mimeType: "image/jpeg",
      attachmentId: file!.relativePath.replace(/\.jpg$/u, ""),
    });
  });

  it("moves Claude's tool_result picture the same way", () => {
    const moved = externalizeSnapshotImages({
      payload: {
        itemType: "mcp_tool_call",
        data: {
          toolName: "mcp__t3-code__preview_snapshot",
          result: {
            type: "tool_result",
            content: [
              { type: "image", source: { type: "base64", media_type: "image/jpeg", data: jpeg } },
            ],
          },
        },
      },
      summary: "MCP tool call",
      threadId: "thread-1",
    });
    assert.equal(moved?.files.length, 1);
    assert.deepInclude(
      (moved!.payload as { data: { result: { content: unknown[] } } }).data.result
        .content[0] as object,
      { type: "image", mimeType: "image/jpeg" },
    );
  });

  it("leaves every other tool's result alone", () => {
    assert.isNull(
      externalizeSnapshotImages({
        payload: {
          ...codexSnapshot,
          title: "t3-code · vm_computer",
          data: { item: { tool: "x" } },
        },
        summary: "t3-code · vm_computer",
        threadId: "thread-1",
      }),
    );
  });
});

it.effect("stores the picture once and hands back the activity that references it", () =>
  Effect.gen(function* () {
    const attachmentsDir = yield* Effect.promise(() =>
      NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "snapshot-images-")),
    );
    const activity = { summary: "t3-code · preview_snapshot", payload: codexSnapshot };
    const first = yield* storeSnapshotImages({ activity, threadId: "thread-1", attachmentsDir });
    // The completed row repeats the updated row's picture: same file, no error.
    const second = yield* storeSnapshotImages({ activity, threadId: "thread-1", attachmentsDir });
    assert.deepEqual(first, second);
    const files = yield* Effect.promise(() => NodeFSP.readdir(attachmentsDir));
    assert.equal(files.length, 1);
    const bytes = yield* Effect.promise(() =>
      NodeFSP.readFile(NodePath.join(attachmentsDir, files[0]!)),
    );
    assert.deepEqual([...bytes], [0xff, 0xd8, 0xff, 0xd9]);
    yield* Effect.promise(() => NodeFSP.rm(attachmentsDir, { recursive: true, force: true }));
  }),
);
