import {
  EventId,
  MessageId,
  type OrchestrationMessage,
  type OrchestrationThreadActivity,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import {
  activityAuthorizesExternalImagePath,
  messageAuthorizesExternalImagePath,
} from "./ThreadAssetAuthorization.ts";

const WINDOWS_IMAGE_PATH = String.raw`D:\TerraGen\Temp\BillboardNormalValidation\conifer_22_5.png`;

function makeImageActivity(
  overrides: Partial<OrchestrationThreadActivity> = {},
): OrchestrationThreadActivity {
  return {
    id: EventId.make("activity-image-view"),
    tone: "tool",
    kind: "tool.completed",
    summary: "Image view",
    payload: {
      itemType: "image_view",
      detail: WINDOWS_IMAGE_PATH,
      data: {
        item: {
          id: "exec-1",
          path: WINDOWS_IMAGE_PATH,
          type: "imageView",
        },
      },
    },
    turnId: null,
    createdAt: "2026-07-30T12:00:00.000Z",
    ...overrides,
  };
}

describe("activityAuthorizesExternalImagePath", () => {
  it("authorizes an image Codex GENERATED, which reports savedPath not path", () => {
    // Codex emits itemType `image_view` for both viewing an image and for its
    // own image-generation tool. Generation writes the file and reports
    // `savedPath`; only `path` was accepted, so a generated image rendered as a
    // bare "Image view" row with nothing to look at (reported 2026-08-31).
    const generatedPath = "/Users/dev/.codex/generated_images/thread-1/exec-2.png";
    const generated = makeImageActivity({
      payload: {
        itemType: "image_view",
        data: {
          item: {
            id: "exec-2",
            type: "imageGeneration",
            status: "completed",
            savedPath: generatedPath,
          },
        },
      },
    });
    expect(activityAuthorizesExternalImagePath(generated, generatedPath)).toBe(true);
    // Still exact-match only: a sibling in the same directory is not authorized.
    expect(
      activityAuthorizesExternalImagePath(
        generated,
        "/Users/dev/.codex/generated_images/thread-1/other.png",
      ),
    ).toBe(false);
  });

  it("authorizes the exact Windows image path emitted by an image-view activity", () => {
    expect(
      activityAuthorizesExternalImagePath(
        makeImageActivity(),
        "D:/TerraGen/Temp/BillboardNormalValidation/conifer_22_5.png",
      ),
    ).toBe(true);
  });

  it("does not authorize a sibling path or an unrelated tool activity", () => {
    expect(
      activityAuthorizesExternalImagePath(
        makeImageActivity(),
        String.raw`D:\TerraGen\Temp\BillboardNormalValidation\other.png`,
      ),
    ).toBe(false);
    expect(
      activityAuthorizesExternalImagePath(
        makeImageActivity({
          payload: {
            itemType: "command_execution",
            detail: WINDOWS_IMAGE_PATH,
          },
        }),
        WINDOWS_IMAGE_PATH,
      ),
    ).toBe(false);
  });

  it("authorizes an exact /tmp image emitted by a Claude dynamic Read tool call", () => {
    const imagePath = "/tmp/wood_maps.png";
    const activity = makeImageActivity({
      id: EventId.make("activity-claude-read"),
      summary: "Tool call",
      payload: {
        itemType: "dynamic_tool_call",
        title: "Tool call",
        detail: `Read: ${JSON.stringify({ file_path: imagePath })}`,
        data: {
          kind: "read",
          input: { file_path: imagePath },
        },
      },
    });

    expect(activityAuthorizesExternalImagePath(activity, imagePath)).toBe(true);
    expect(activityAuthorizesExternalImagePath(activity, "/tmp/other.png")).toBe(false);
  });

  it("recognizes projected file candidates while retaining exact-path authorization", () => {
    const imagePath = "/tmp/projected-preview.png";
    const activity = makeImageActivity({
      id: EventId.make("activity-projected-read"),
      summary: "Read File",
      payload: {
        itemType: "dynamic_tool_call",
        title: "Read File",
        data: {
          kind: "read",
          files: [{ path: imagePath }],
        },
      },
    });

    expect(activityAuthorizesExternalImagePath(activity, imagePath)).toBe(true);
    expect(activityAuthorizesExternalImagePath(activity, "/tmp/projected-sibling.png")).toBe(false);
  });
});

function makeAssistantMessage(
  text: string,
  overrides: Partial<OrchestrationMessage> = {},
): OrchestrationMessage {
  return {
    id: MessageId.make("assistant-message-image-link"),
    role: "assistant",
    text,
    turnId: null,
    streaming: false,
    createdAt: "2026-07-30T12:00:00.000Z",
    updatedAt: "2026-07-30T12:00:00.000Z",
    ...overrides,
  };
}

describe("messageAuthorizesExternalImagePath", () => {
  it("authorizes only the exact /tmp image linked by the assistant message", () => {
    const imagePath = "/tmp/live_billboard_move_sweep/move_sweep_mosaic.png";
    const message = makeAssistantMessage(
      `The measured boundary improved. [move_sweep_mosaic.png](${imagePath}) shows the result.`,
    );

    expect(messageAuthorizesExternalImagePath(message, imagePath)).toBe(true);
    expect(
      messageAuthorizesExternalImagePath(message, "/tmp/live_billboard_move_sweep/unlinked.png"),
    ).toBe(false);
  });

  it("supports encoded, file URL, and inline-code image references", () => {
    expect(
      messageAuthorizesExternalImagePath(
        makeAssistantMessage("[preview](file:///tmp/image%20preview.png)"),
        "/tmp/image preview.png",
      ),
    ).toBe(true);
    expect(
      messageAuthorizesExternalImagePath(
        makeAssistantMessage("Open `/tmp/inline-preview.png` to inspect it."),
        "/tmp/inline-preview.png",
      ),
    ).toBe(true);
  });

  it("rejects unlinked plain-text paths", () => {
    expect(
      messageAuthorizesExternalImagePath(
        makeAssistantMessage("Generated /tmp/plain-text-only.png"),
        "/tmp/plain-text-only.png",
      ),
    ).toBe(false);
  });

  it("does not authorize paths linked by user messages", () => {
    const imagePath = "/tmp/user-linked.png";
    expect(
      messageAuthorizesExternalImagePath(
        makeAssistantMessage(`[preview](${imagePath})`, { role: "user" }),
        imagePath,
      ),
    ).toBe(false);
  });
});
