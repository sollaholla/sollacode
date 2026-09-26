import { describe, expect, it } from "vite-plus/test";

import {
  inlineToolImageDataUrl,
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

describe("inline tool image data", () => {
  const base64 = "iVBORw0KGgoAAAANSUhEUg";

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
          item: { result: { content: [{ type: "image", mimeType: "image/jpeg", data: base64 }] } },
        },
      }),
    ).toBe(`data:image/jpeg;base64,${base64}`);
  });

  it("strips the wrapping a line-broken payload carries", () => {
    expect(
      inlineToolImageDataUrl({
        content: [{ type: "image", mimeType: "IMAGE/PNG", data: `${base64}\n${base64}` }],
      }),
    ).toBe(`data:image/png;base64,${base64}${base64}`);
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
