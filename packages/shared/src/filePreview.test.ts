import { describe, expect, it } from "vite-plus/test";

import {
  inlineToolImageDataUrl,
  isPreviewSnapshotToolCall,
  previewSnapshotImage,
  readImageToolOutputPath,
  isWorkspaceAudioPreviewPath,
  isWorkspaceBrowserPreviewPath,
  isWorkspaceImagePreviewPath,
  isWorkspaceMediaPreviewPath,
  isWorkspacePdfPreviewPath,
  isWorkspacePreviewEntryPath,
  isWorkspaceVideoPreviewPath,
  workspaceAudioMimeType,
  workspaceVideoMimeType,
} from "./filePreview.ts";

describe("Deep Code image-read receipts", () => {
  it.each([
    String.raw`D:\TerraGen\Assets\Temp\nf_probe_100.png`,
    "/tmp/render with spaces.png",
    "Assets/Temp/probe.png",
  ])("extracts %s without the ReadImage label", (path) => {
    expect(
      readImageToolOutputPath({
        itemType: "image_view",
        title: "Image view",
        detail: `ReadImage: ${path}`,
        data: { toolName: "ReadImage", params: path },
      }),
    ).toBe(path);
    expect(
      readImageToolOutputPath({
        itemType: "image_view",
        title: "Image view",
        detail: `ReadImage: ${path}`,
      }),
    ).toBe(path);
  });
  it("prefers the full receipt path over truncated display detail", () => {
    expect(
      readImageToolOutputPath({
        itemType: "image_view",
        detail: "ReadImage: D:/very/long/…",
        data: { toolName: "ReadImage", params: "D:/very/long/full name.png" },
      }),
    ).toBe("D:/very/long/full name.png");
  });
  it.each(["https://example.com/image.png", "file:///tmp/image.png", "notes.txt"])(
    "rejects non-workspace raster receipt %s",
    (path) => {
      expect(
        readImageToolOutputPath({
          itemType: "image_view",
          detail: `ReadImage: ${path}`,
          data: { toolName: "ReadImage", params: path },
        }),
      ).toBeNull();
    },
  );
  it("does not treat command output as an image read", () => {
    expect(
      readImageToolOutputPath({
        itemType: "command_execution",
        detail: "ReadImage: D:/secret.png",
      }),
    ).toBeNull();
  });
});

describe("Image view paths", () => {
  const path = "/workspace/agents/project/evidence/native-capture/eye-forward-00.png";

  it.each([
    { item: { type: "imageView", path } },
    { files: [{ path }] },
    { path },
    { item: { type: "imageGeneration", savedPath: path } },
  ])("recovers the full path when display detail was truncated: %j", (data) => {
    expect(
      readImageToolOutputPath({ itemType: "image_view", detail: path.slice(0, 40) + "...", data }),
    ).toBe(path);
  });

  it("supports historical image-view rows that only retain their full detail", () => {
    expect(readImageToolOutputPath({ itemType: "image_view", detail: path })).toBe(path);
  });

  it.each([
    "https://example.com/image.png",
    "file:///tmp/image.png",
    "image.svg",
    "image.png.ts",
    "bad\npath.png",
  ])("rejects a non-raster or non-file image-view path: %s", (path) => {
    expect(
      readImageToolOutputPath({ itemType: "image_view", data: { files: [{ path }] } }),
    ).toBeNull();
  });

  it.each(["command_execution", "file_change", "dynamic_tool_call"])(
    "does not turn an incidental file list into an image read for %s",
    (itemType) => {
      expect(readImageToolOutputPath({ itemType, data: { files: [{ path }] } })).toBeNull();
    },
  );
});

describe("workspace file previews", () => {
  it.each(["report.html", "report.HTM", "document.pdf?download=1"])(
    "recognizes browser preview path %s",
    (path) => {
      expect(isWorkspaceBrowserPreviewPath(path)).toBe(true);
      expect(isWorkspacePreviewEntryPath(path)).toBe(true);
    },
  );

  it.each([
    "icon.png",
    "photo.JPEG",
    "animation.gif",
    "vector.svg#mark",
    "texture.webp",
    "image.avif",
  ])("recognizes image preview path %s", (path) => {
    expect(isWorkspaceImagePreviewPath(path)).toBe(true);
    expect(isWorkspacePreviewEntryPath(path)).toBe(true);
  });

  it.each(["README.md", "src/index.ts", "image.png.ts", "png"])(
    "rejects non-preview path %s",
    (path) => {
      expect(isWorkspacePreviewEntryPath(path)).toBe(false);
    },
  );

  it.each(["clip.mp4", "Screen Recording.MOV", "loop.webm", "old.ogv", "short.m4v"])(
    "recognizes video preview path %s",
    (path) => {
      expect(isWorkspaceVideoPreviewPath(path)).toBe(true);
      expect(isWorkspaceMediaPreviewPath(path)).toBe(true);
    },
  );

  // Containers no browser can decode stay out on purpose: listing them would
  // trade a working "open in your player" for a black rectangle.
  it.each(["movie.mkv", "clip.avi", "legacy.wmv", "old.flv"])(
    "leaves undecodable container %s to the system player",
    (path) => {
      expect(isWorkspaceVideoPreviewPath(path)).toBe(false);
      expect(isWorkspaceMediaPreviewPath(path)).toBe(false);
    },
  );

  it("types each video so a player does not refuse a file it could decode", () => {
    expect(workspaceVideoMimeType("a.mp4")).toBe("video/mp4");
    expect(workspaceVideoMimeType("a.m4v")).toBe("video/mp4");
    expect(workspaceVideoMimeType("a.mov")).toBe("video/quicktime");
    expect(workspaceVideoMimeType("a.webm")).toBe("video/webm");
    expect(workspaceVideoMimeType("a.ogv")).toBe("video/ogg");
    expect(workspaceVideoMimeType("notes.md")).toBeNull();
  });

  it.each(["song.mp3", "Voice Note.WAV", "take.m4a", "loop.ogg", "master.flac", "clip.aac"])(
    "recognizes audio preview path %s",
    (path) => {
      expect(isWorkspaceAudioPreviewPath(path)).toBe(true);
      expect(isWorkspaceMediaPreviewPath(path)).toBe(true);
    },
  );

  it("types each audio file so a player does not refuse a file it could decode", () => {
    expect(workspaceAudioMimeType("a.mp3")).toBe("audio/mpeg");
    expect(workspaceAudioMimeType("a.wav")).toBe("audio/wav");
    expect(workspaceAudioMimeType("a.m4a")).toBe("audio/mp4");
    expect(workspaceAudioMimeType("a.aac")).toBe("audio/aac");
    expect(workspaceAudioMimeType("a.ogg")).toBe("audio/ogg");
    expect(workspaceAudioMimeType("a.flac")).toBe("audio/flac");
    expect(workspaceAudioMimeType("notes.md")).toBeNull();
  });

  it("counts PDF as media the panel renders itself", () => {
    expect(isWorkspacePdfPreviewPath("spec.pdf")).toBe(true);
    expect(isWorkspaceMediaPreviewPath("spec.pdf")).toBe(true);
    expect(isWorkspaceMediaPreviewPath("icon.png")).toBe(true);
    expect(isWorkspaceMediaPreviewPath("notes.md")).toBe(false);
  });
});

describe("readImageToolOutputPath", () => {
  const receipt = (path: string, itemType = "dynamic_tool_call") => ({
    itemType,
    title: "Tool",
    detail: `Read image file \`${path}\` as model-visible image output.\nmedia_type: image/png\nsource_bytes: 4173209`,
  });
  it.each([
    "screenshots/plateau_edge_to_bay.png",
    "/tmp/render with spaces.png",
    "C:\\renders\\scene.png",
  ])("extracts the explicit receipt path %s", (path) => {
    expect(readImageToolOutputPath(receipt(path))).toBe(path);
  });
  it.each(["https://example.com/image.png", "file:///tmp/image.png", "image.svg", "image.png.ts"])(
    "rejects unsupported paths %s",
    (path) => {
      expect(readImageToolOutputPath(receipt(path))).toBeNull();
    },
  );
  it("does not promote shell output or incidental prose to an image read", () => {
    expect(readImageToolOutputPath(receipt("image.png", "command_execution"))).toBeNull();
    expect(readImageToolOutputPath({ ...receipt("image.png"), detail: "image.png" })).toBeNull();
    expect(
      readImageToolOutputPath({
        ...receipt("image.png"),
        detail: "Example: " + receipt("image.png").detail,
      }),
    ).toBeNull();
  });
});

// A whole 1x1 PNG and a minimal JPEG (start and end markers): the completeness
// check reads each format's end marker, so fixtures must carry one.
const png =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
const jpeg = "/9j/2Q==";

describe("inline tool image data", () => {
  const base64 = png;

  it("recovers the image an Anthropic read tool returned", () => {
    expect(
      inlineToolImageDataUrl({
        itemType: "dynamic_tool_call",
        detail: 'Read: {"file_path":"/tmp/shot.png"}',
        data: {
          toolName: "Read",
          input: { file_path: "/tmp/shot.png" },
          result: {
            type: "tool_result",
            content: [
              { type: "image", source: { type: "base64", media_type: "image/png", data: base64 } },
            ],
          },
        },
      }),
    ).toBe(`data:image/png;base64,${base64}`);
  });

  it("recovers the MCP and ACP shape, which names the type inline", () => {
    expect(
      inlineToolImageDataUrl({
        data: {
          item: { result: { content: [{ type: "image", mimeType: "image/jpeg", data: jpeg }] } },
        },
      }),
    ).toBe(`data:image/jpeg;base64,${jpeg}`);
  });

  it("strips the wrapping a line-broken payload carries", () => {
    expect(
      inlineToolImageDataUrl({
        content: [
          {
            type: "image",
            mimeType: "IMAGE/PNG",
            data: `${base64.slice(0, 40)}\n${base64.slice(40)}`,
          },
        ],
      }),
    ).toBe(`data:image/png;base64,${base64}`);
  });

  it("refuses a copy a payload cap cut short", () => {
    // What the 16 KB cap left of a Codex snapshot: the top of the page, then
    // nothing; drawn, it is the page over grey.
    expect(
      inlineToolImageDataUrl({
        content: [{ type: "image", mimeType: "image/jpeg", data: "/9j/4AAQSkZJRgABAQAAAQABAAD" }],
      }),
    ).toBeNull();
    expect(
      inlineToolImageDataUrl({
        content: [{ type: "image", mimeType: "image/png", data: png.slice(0, 40) }],
      }),
    ).toBeNull();
  });

  it.each([
    [
      "a media type that is not a raster image",
      { type: "image", mimeType: "image/svg+xml", data: base64 },
    ],
    [
      "a remote reference rather than bytes",
      { type: "image", source: { type: "url", url: "https://example.com/a.png" } },
    ],
    [
      "data that is not base64",
      { type: "image", mimeType: "image/png", data: "<svg onload=alert(1)>" },
    ],
    ["an empty payload", { type: "image", mimeType: "image/png", data: "   " }],
  ])("ignores %s", (_label, block) => {
    expect(inlineToolImageDataUrl({ data: { result: { content: [block] } } })).toBeNull();
  });

  it("ignores a payload with no image block at all", () => {
    expect(
      inlineToolImageDataUrl({ data: { result: { content: [{ type: "text", text: base64 }] } } }),
    ).toBeNull();
  });
});

describe("previewSnapshotImage", () => {
  const claudeRow = {
    itemType: "mcp_tool_call",
    title: "MCP tool call",
    data: {
      toolName: "mcp__t3-code__preview_snapshot",
      result: {
        type: "tool_result",
        content: [
          { type: "text", text: '{"url":"https://example.com"}' },
          { type: "image", source: { type: "base64", media_type: "image/jpeg", data: jpeg } },
        ],
      },
    },
  };
  const codexRow = {
    itemType: "mcp_tool_call",
    title: "t3-code · preview_snapshot",
    data: {
      item: {
        server: "t3-code",
        tool: "preview_snapshot",
        result: { content: [{ type: "image", data: jpeg, mimeType: "image/jpeg" }] },
      },
    },
  };

  it("finds the page a snapshot captured, however the provider spells the call", () => {
    const inline = { kind: "inline", src: `data:image/jpeg;base64,${jpeg}` };
    expect(previewSnapshotImage(claudeRow)).toEqual(inline);
    expect(previewSnapshotImage(codexRow)).toEqual(inline);
    expect(
      previewSnapshotImage(
        { data: { result: { content: [{ type: "image", data: jpeg, mimeType: "image/jpeg" }] } } },
        "t3-code · preview_snapshot",
      ),
    ).toEqual(inline);
  });

  it("prefers the attachment the server stored the picture in", () => {
    expect(
      previewSnapshotImage({
        ...codexRow,
        data: {
          item: {
            ...codexRow.data.item,
            result: {
              content: [{ type: "image", mimeType: "image/jpeg", attachmentId: "thread-1-abc" }],
            },
          },
        },
      }),
    ).toEqual({ kind: "attachment", attachmentId: "thread-1-abc" });
  });

  it("leaves other tools' images to their own rows", () => {
    expect(
      previewSnapshotImage({
        ...claudeRow,
        data: { ...claudeRow.data, toolName: "mcp__t3-code__vm_computer" },
      }),
    ).toBeNull();
    expect(
      previewSnapshotImage({ ...codexRow, title: "t3-code · preview_click", data: {} }),
    ).toBeNull();
    expect(isPreviewSnapshotToolCall(codexRow)).toBe(true);
  });

  it("answers from the same payload without walking it again", () => {
    const row = structuredClone(codexRow);
    const first = inlineToolImageDataUrl(row);
    row.data.item.result.content = [];
    // Payloads are immutable state; the remembered answer is the right one.
    expect(inlineToolImageDataUrl(row)).toBe(first);
  });
});
