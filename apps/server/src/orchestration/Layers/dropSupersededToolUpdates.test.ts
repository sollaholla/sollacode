import { describe, expect, it } from "vite-plus/test";

import { dropSupersededToolUpdates, trimSnapshotToolRawOutput } from "./ProjectionSnapshotQuery.ts";

const updated = (toolCallId: string | null) => ({
  kind: "tool.updated",
  payload: { data: toolCallId === null ? {} : { toolCallId }, content: "partial output" },
});
const completed = (toolCallId: string) => ({
  kind: "tool.completed",
  payload: { data: { toolCallId }, content: "final output" },
});

/**
 * Measured on a real thread: all 257 `tool.updated` rows in a 750-activity
 * snapshot were superseded, carrying 2125 KB of a 6389 KB payload that is
 * schema-decoded twice — server and client — before a thread stops loading.
 */
describe("dropSupersededToolUpdates", () => {
  it("drops an in-flight frame the completion already replaced", () => {
    const result = dropSupersededToolUpdates([updated("call-1"), completed("call-1")]);
    expect(result).toEqual([completed("call-1")]);
  });

  it("keeps a tool that never completed, its last frame being the only record", () => {
    // An interrupted turn has no completion to fall back on.
    const activities = [updated("call-1"), completed("call-2"), updated("call-2")];
    expect(dropSupersededToolUpdates(activities)).toEqual([updated("call-1"), completed("call-2")]);
  });

  it("keeps a frame with no tool call id, which nothing can supersede", () => {
    const activities = [updated(null), completed("call-1")];
    expect(dropSupersededToolUpdates(activities)).toEqual(activities);
  });

  it("leaves every other kind of activity untouched", () => {
    const others = [
      { kind: "message.delivered", payload: { data: { toolCallId: "call-1" } } },
      { kind: "tool.started", payload: { data: { toolCallId: "call-1" } } },
      completed("call-1"),
    ];
    expect(dropSupersededToolUpdates(others)).toEqual(others);
  });

  it("returns the input untouched when nothing completed", () => {
    const activities = [updated("call-1"), updated("call-2")];
    expect(dropSupersededToolUpdates(activities)).toBe(activities);
  });

  it("tolerates malformed payloads rather than dropping data on a guess", () => {
    const malformed = [
      { kind: "tool.updated", payload: null },
      { kind: "tool.updated", payload: { data: "not-an-object" } },
      completed("call-1"),
    ];
    expect(dropSupersededToolUpdates(malformed)).toEqual(malformed);
  });
});

const rawOutputActivity = (rawOutput: Record<string, unknown>) => ({
  kind: "tool.completed",
  payload: { data: { toolCallId: "call-1", rawOutput } },
});

const readRawOutput = (activity: { readonly payload: unknown }): Record<string, unknown> => {
  const payload = activity.payload as { data: { rawOutput: Record<string, unknown> } };
  return payload.data.rawOutput;
};

/**
 * `rawOutput` was 2879 KB of a 4263 KB snapshot on a real thread, and nothing
 * renders it: the web timeline derives one 84-character line, and the mobile
 * and shared clients never read it.
 */
describe("trimSnapshotToolRawOutput", () => {
  it("keeps the first line intact so the client's preview is unchanged", () => {
    const first = "first line of output";
    const [trimmed] = trimSnapshotToolRawOutput([
      rawOutputActivity({ content: `${first}\n${"x".repeat(50_000)}` }),
    ]);

    const content = readRawOutput(trimmed!).content as string;
    expect(content.startsWith(first)).toBe(true);
    expect(content.length).toBe(2_048);
  });

  it("trims text nested under a tool-specific shape, not just the top level", () => {
    // A ReadFile result carries the whole file at rawOutput.FileContent.content.
    // Capping only the known top-level keys missed 2.4 MB of exactly this.
    const [trimmed] = trimSnapshotToolRawOutput([
      rawOutputActivity({ type: "ReadFile", FileContent: { content: "f".repeat(260_000) } }),
    ]);

    const fileContent = readRawOutput(trimmed!).FileContent as { content: string };
    expect(fileContent.content.length).toBe(2_048);
    expect(readRawOutput(trimmed!).type).toBe("ReadFile");
  });

  it("trims through arrays as well as objects", () => {
    const [trimmed] = trimSnapshotToolRawOutput([
      rawOutputActivity({ parts: [{ text: "t".repeat(9_000) }] }),
    ]);

    const parts = readRawOutput(trimmed!).parts as ReadonlyArray<{ text: string }>;
    expect(parts[0]!.text.length).toBe(2_048);
  });

  it("leaves short output byte-identical rather than rebuilding it", () => {
    const activity = rawOutputActivity({ content: "short output" });
    expect(trimSnapshotToolRawOutput([activity])[0]).toBe(activity);
  });

  it("preserves the other fields the client reads for a summary", () => {
    // `totalFiles`/`truncated` drive the "N files+" summary and must survive.
    const activity = rawOutputActivity({
      totalFiles: 12,
      truncated: true,
      content: "c".repeat(9_000),
    });
    const rawOutput = readRawOutput(trimSnapshotToolRawOutput([activity])[0]!);
    expect(rawOutput.totalFiles).toBe(12);
    expect(rawOutput.truncated).toBe(true);
  });

  it("passes through activities with no rawOutput at all", () => {
    const activities = [{ kind: "message.delivered", payload: { data: {} } }, { payload: null }];
    expect(trimSnapshotToolRawOutput(activities)).toEqual(activities);
  });
});
