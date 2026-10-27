// @effect-diagnostics globalFetch:off - Exercises the viewer as the browser panel does, over plain HTTP.
import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  parseAndroidViewerInput,
  pngSize,
  quoteAndroidInputText,
  startAndroidViewer,
  type AndroidViewer,
  type AndroidViewerInput,
} from "./androidViewer.ts";

const PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 1, 0,
  0, 0, 2, 0,
]);

describe("Android viewer input", () => {
  it("accepts touches as fractions of the picture and drops anything else", () => {
    expect(parseAndroidViewerInput({ kind: "touch", phase: "down", x: 0.5, y: 1 })).toEqual({
      kind: "touch",
      phase: "down",
      x: 0.5,
      y: 1,
    });
    expect(parseAndroidViewerInput({ kind: "touch", phase: "down", x: 2, y: 0 })).toBeNull();
    expect(parseAndroidViewerInput({ kind: "touch", phase: "hover", x: 0, y: 0 })).toBeNull();
    expect(
      parseAndroidViewerInput({ kind: "swipe", x1: 0, y1: 0, x2: 1, y2: 1, durationMs: 99_999 }),
    ).toMatchObject({ durationMs: 2_000 });
    expect(parseAndroidViewerInput({ kind: "key", key: "home" })).toEqual({
      kind: "key",
      key: "home",
    });
    expect(parseAndroidViewerInput({ kind: "key", key: "toString" })).toBeNull();
    expect(parseAndroidViewerInput({ kind: "text", text: "x".repeat(1_001) })).toBeNull();
  });

  it("quotes typed text for the device shell", () => {
    expect(quoteAndroidInputText("it's here\n")).toBe("'it'\\''s%shere'");
  });

  it("reads a PNG's size", () => {
    expect(pngSize(PNG)).toEqual({ width: 256, height: 512 });
    expect(pngSize(Buffer.from("not a png at all, really"))).toBeNull();
  });
});

describe("Android viewer server", () => {
  let viewer: AndroidViewer | null = null;
  afterEach(async () => {
    await viewer?.close();
    viewer = null;
  });

  it("serves frames and input only under its token, for running emulators", async () => {
    const received: AndroidViewerInput[] = [];
    const widths: number[] = [];
    viewer = await startAndroidViewer({
      screenFor: async (name) =>
        name === "Pixel_9"
          ? {
              capture: async (width) => {
                widths.push(width);
                return PNG;
              },
              input: async (event) => {
                received.push(event);
              },
            }
          : null,
    });
    const url = viewer.urlFor("Pixel_9");
    const origin = new URL(url).origin;

    expect((await fetch(`${origin}/wrong-token/Pixel_9/frame`)).status).toBe(404);
    expect((await fetch(url)).headers.get("content-type")).toMatch(/text\/html/u);
    expect((await fetch(viewer.urlFor("Off_Device") + "frame")).status).toBe(503);

    const frame = await fetch(`${url}frame?w=480`);
    expect(frame.status).toBe(200);
    expect(Buffer.from(await frame.arrayBuffer())).toEqual(PNG);
    expect(widths).toEqual([480]);
    const frameId = frame.headers.get("x-frame-id") ?? "";
    expect((await fetch(`${url}frame?w=480&known=${encodeURIComponent(frameId)}`)).status).toBe(
      204,
    );

    const post = (body: string) => fetch(`${url}input`, { method: "POST", body });
    expect((await post(JSON.stringify({ kind: "key", key: "back" }))).status).toBe(204);
    expect((await post("{not json")).status).toBe(400);
    expect((await post(JSON.stringify({ kind: "text", text: "x".repeat(9_000) }))).status).toBe(
      413,
    );
    expect(received).toEqual([{ kind: "key", key: "back" }]);
  });
});
