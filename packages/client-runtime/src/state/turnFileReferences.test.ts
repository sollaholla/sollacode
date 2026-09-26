import { describe, expect, it } from "vite-plus/test";
import { collectThreadFileReferencesByTurnId as collect } from "./turnFileReferences.js";
const message = (text: string, turnId = "turn-1") => ({
  id: "message-1",
  role: "assistant",
  turnId,
  text,
});
describe("turn file references", () => {
  it("collects media and documents, resolves paths and deduplicates line references", () => {
    const result = collect({
      cwd: "/workspace",
      activities: [],
      messages: [
        message(
          "[Photo](<shots/my photo.png>) [Video](clips/test.mp4) [Voice](audio.wav) [Report](report.pdf) `src/main.ts:12` [Same](src/main.ts:30)",
        ),
      ],
    }).get("turn-1");
    expect(result?.map(({ path, kind }) => [path, kind])).toEqual([
      ["/workspace/shots/my photo.png", "image"],
      ["/workspace/clips/test.mp4", "video"],
      ["/workspace/audio.wav", "audio"],
      ["/workspace/report.pdf", "document"],
      ["/workspace/src/main.ts", "file"],
    ]);
    expect(result?.[0]?.sourceMessageId).toBe("message-1");
  });
  it("does not collect user text, commands, code blocks, unsafe schemes or web pages", () => {
    expect(
      collect({
        activities: [
          {
            id: "command",
            turnId: "turn-1",
            payload: { itemType: "command_execution", path: "secret.png", output: "photo.png" },
          },
        ],
        messages: [
          { ...message("[image](user.png)"), role: "user" },
          message(
            "```\n[image](example.png)\n``` [unsafe](javascript:foo.png) [web](https://example.com/page)",
          ),
        ],
      }).size,
    ).toBe(0);
  });
  it("excludes remote media URLs and keeps local turn ownership", () => {
    const refs = collect({
      activities: [],
      messages: [
        message("[clip](https://example.com/clip.mp4?token=123)", "a"),
        message("[doc](report.pdf)", "b"),
      ],
    });
    expect(refs.has("a")).toBe(false);
    expect(refs.get("b")?.[0]?.path).toBe("report.pdf");
  });
  it.each([
    { itemType: "image_view", data: { item: { path: "photo.png" } } },
    { title: "Read", data: { rawInput: { file_path: "photo.png" } } },
    { detail: 'Read : {"file_path":"photo.png"}' },
    { itemType: "file_read", input: { path: "photo.png" } },
  ])("collects structured file tool references independently of provider: %j", (payload) => {
    const refs = collect({
      cwd: "/workspace",
      messages: [],
      activities: [{ id: "tool-1", turnId: "turn-1", payload }],
    });
    expect(refs.get("turn-1")).toEqual([
      {
        path: "/workspace/photo.png",
        name: "photo.png",
        kind: "image",
        sourceActivityId: "tool-1",
      },
    ]);
  });
  it("keeps extensionless and Windows file candidates for host verification", () => {
    const refs = collect({
      cwd: "C:/work",
      activities: [],
      messages: [message("[License](LICENSE) [Config](.env) [Code](<C:/work/src/main.ts:12>)")],
    });
    expect(refs.get("turn-1")?.map((r) => r.path)).toEqual([
      "C:/work/LICENSE",
      "C:/work/.env",
      "C:/work/src/main.ts",
    ]);
  });
  it("bounds references per turn", () => {
    expect(
      collect({
        messages: [
          message(Array.from({ length: 150 }, (_, i) => `[file](file${i}.png)`).join(" ")),
        ],
        activities: [],
      }).get("turn-1"),
    ).toHaveLength(100);
  });
});
