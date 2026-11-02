import {
  EventId,
  MessageId,
  type OrchestrationMessage,
  type OrchestrationThreadActivity,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import {
  activityAuthorizesExternalImagePath,
  expandHostHomePath,
  messageAuthorizesExternalFilePath,
  messageAuthorizesExternalImagePath,
  threadFileMentionTerms,
} from "./ThreadAssetAuthorization.ts";

const WINDOWS_IMAGE_PATH = String.raw`D:\GameProject\Temp\BillboardNormalValidation\conifer_22_5.png`;

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
  it("authorizes only the exact image in a persisted Muse read receipt", () => {
    const payload = {
      itemType: "dynamic_tool_call",
      title: "Tool",
      detail:
        "Read image file `/tmp/render with spaces.png` as model-visible image output.\nmedia_type: image/png\nsource_bytes: 4173209",
    };
    const activity = makeImageActivity({
      summary: "Tool",
      payload,
    });
    expect(activityAuthorizesExternalImagePath(activity, "/tmp/render with spaces.png")).toBe(true);
    expect(activityAuthorizesExternalImagePath(activity, "/tmp/sibling.png")).toBe(false);
    expect(
      activityAuthorizesExternalImagePath(
        { ...activity, payload: { ...payload, itemType: "command_execution" } },
        "/tmp/render with spaces.png",
      ),
    ).toBe(false);
  });

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
        "D:/GameProject/Temp/BillboardNormalValidation/conifer_22_5.png",
      ),
    ).toBe(true);
  });

  it("authorizes the actual file from a saved Deep Code ReadImage receipt", () => {
    const path = String.raw`D:\GameProject\Assets\Temp\nf_probe_100.png`;
    const activity = makeImageActivity({
      payload: {
        itemType: "image_view",
        title: "Image view",
        detail: `ReadImage: ${path}`,
        data: { toolName: "ReadImage", params: path },
      },
    });
    expect(activityAuthorizesExternalImagePath(activity, path)).toBe(true);
    expect(
      activityAuthorizesExternalImagePath(activity, "D:/GameProject/Assets/Temp/other.png"),
    ).toBe(false);
  });

  it("does not authorize a sibling path or an unrelated tool activity", () => {
    expect(
      activityAuthorizesExternalImagePath(
        makeImageActivity(),
        String.raw`D:\GameProject\Temp\BillboardNormalValidation\other.png`,
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

  it("authorizes a linked file name with parentheses, as Windows names copies", () => {
    expect(
      messageAuthorizesExternalImagePath(
        makeAssistantMessage(String.raw`[shot](C:\Temp\Screenshot(3).png)`),
        String.raw`C:\Temp\Screenshot(3).png`,
      ),
    ).toBe(true);
    expect(
      messageAuthorizesExternalImagePath(
        makeAssistantMessage("[shot](/tmp/Screenshot(3).png)"),
        "/tmp/Screenshot(3.png",
      ),
    ).toBe(false);
  });

  it("reads a home-relative destination as the path clients resolve it to", () => {
    const message = makeAssistantMessage("Saved to `~/Desktop/shot.png`.");
    expect(
      messageAuthorizesExternalImagePath(message, "/Users/me/Desktop/shot.png", "/Users/me"),
    ).toBe(true);
    expect(
      messageAuthorizesExternalImagePath(message, "/Users/me/Desktop/other.png", "/Users/me"),
    ).toBe(false);
    expect(messageAuthorizesExternalImagePath(message, "/Users/me/Desktop/shot.png")).toBe(false);
  });

  it("authorizes a path written in plain text", () => {
    expect(
      messageAuthorizesExternalImagePath(
        makeAssistantMessage("Generated /tmp/plain-text-only.png, and it looks right."),
        "/tmp/plain-text-only.png",
      ),
    ).toBe(true);
    expect(
      messageAuthorizesExternalImagePath(
        makeAssistantMessage("Saved it to /tmp/end-of-sentence.png."),
        "/tmp/end-of-sentence.png",
      ),
    ).toBe(true);
    expect(
      messageAuthorizesExternalImagePath(
        makeAssistantMessage("Saved it to ~/Desktop/plain.png"),
        "/Users/me/Desktop/plain.png",
        "/Users/me",
      ),
    ).toBe(true);
  });

  it("does not read a longer name or path as the one requested", () => {
    for (const text of [
      "Generated /tmp/shot.png.bak",
      "Generated /tmp/shot.pngx",
      "Generated /home/me/tmp/shot.png",
      "Generated ./tmp/shot.png",
      "Generated ~/tmp/shot.png",
      "Nothing to see in /tmp/other.png",
    ]) {
      expect(messageAuthorizesExternalImagePath(makeAssistantMessage(text), "/tmp/shot.png")).toBe(
        false,
      );
    }
  });

  it("compares Windows paths without regard to case or slash direction", () => {
    expect(
      messageAuthorizesExternalImagePath(
        makeAssistantMessage(String.raw`Wrote C:\Users\Me\Shot.PNG for you`),
        "c:/users/me/shot.png",
      ),
    ).toBe(true);
    expect(
      messageAuthorizesExternalImagePath(
        makeAssistantMessage("Wrote /tmp/Shot.png"),
        "/tmp/shot.png",
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

describe("messageAuthorizesExternalFilePath", () => {
  it("covers any file an assistant message names, and nothing else", () => {
    const message = makeAssistantMessage(
      "The report is at /tmp/out/report.pdf and the config in `/etc/app/config.toml:12`. See [notes](/tmp/my%20notes.txt#L4).",
    );
    expect(messageAuthorizesExternalFilePath(message, "/tmp/out/report.pdf")).toBe(true);
    expect(messageAuthorizesExternalFilePath(message, "/etc/app/config.toml")).toBe(true);
    expect(messageAuthorizesExternalFilePath(message, "/tmp/my notes.txt")).toBe(true);
    expect(messageAuthorizesExternalFilePath(message, "/tmp/out/secret.pdf")).toBe(false);
    expect(messageAuthorizesExternalFilePath(message, "/etc/passwd")).toBe(false);
  });

  it("does not let a person's own message authorize a path", () => {
    expect(
      messageAuthorizesExternalFilePath(
        makeAssistantMessage("Please read /etc/passwd", { role: "user" }),
        "/etc/passwd",
      ),
    ).toBe(false);
  });
});

describe("threadFileMentionTerms", () => {
  it("searches for the name as written and as a link encodes it", () => {
    expect(threadFileMentionTerms("/tmp/My Notes.TXT")).toEqual(["my notes.txt", "my%20notes.txt"]);
    expect(threadFileMentionTerms(String.raw`C:\Temp\a.pdf`)).toEqual(["a.pdf"]);
  });
});

describe("expandHostHomePath", () => {
  it("only rewrites a leading home directory", () => {
    expect(expandHostHomePath("~/a.txt", "/Users/me")).toBe("/Users/me/a.txt");
    expect(expandHostHomePath("/tmp/~/a.txt", "/Users/me")).toBe("/tmp/~/a.txt");
  });
});
