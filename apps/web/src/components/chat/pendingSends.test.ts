import { expect, it } from "vite-plus/test";
import { CommandId, MessageId, ThreadId } from "@t3tools/contracts";
import type { DeferredThreadCommandEntry } from "@t3tools/client-runtime/platform";
import { composerDraftMatchesSend, pendingSendMessages } from "./pendingSends";
const threadId = ThreadId.make("side-chat");
const entry: DeferredThreadCommandEntry = {
  command: {
    type: "thread.turn.start",
    commandId: CommandId.make("send:1"),
    threadId,
    message: {
      messageId: MessageId.make("1"),
      role: "user",
      text: "Saved while offline",
      attachments: [
        {
          type: "image",
          name: "picture.png",
          mimeType: "image/png",
          sizeBytes: 3,
          dataUrl: "data:image/png;base64,YWJj",
        },
        {
          type: "audio",
          name: "voice.wav",
          mimeType: "audio/wav",
          sizeBytes: 3,
          durationMs: 1000,
          dataUrl: "data:audio/wav;base64,YWJj",
        },
      ],
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    createdAt: "2026-09-22T00:00:00.000Z",
  },
  enqueuedAt: "2026-09-22T00:00:00.000Z",
};
it("recovers the same side-chat echo and both attachment previews after remount/reload", () => {
  const before = pendingSendMessages([entry], threadId);
  const after = pendingSendMessages(JSON.parse(JSON.stringify([entry])), threadId);
  expect(after).toEqual(before);
  expect(after[0]?.attachments?.map((attachment) => attachment.previewUrl)).toEqual([
    "data:image/png;base64,YWJj",
    "data:audio/wav;base64,YWJj",
  ]);
  expect(pendingSendMessages([entry], ThreadId.make("parent"))).toEqual([]);
});
it("preserves a server-accepted echo until the server row arrives and leaves rejections to the recovery card", () => {
  expect(pendingSendMessages([{ ...entry, accepted: true }], threadId)).toHaveLength(1);
  expect(pendingSendMessages([{ ...entry, error: "Rejected" }], threadId)).toEqual([]);
});

it("only clears the submitted draft, preserving edits to text or any attached context", () => {
  const sent = {
    prompt: "Original message",
    images: [{ id: "image" }],
    terminalContexts: [{ id: "terminal", text: "original" }],
    elementContexts: [{ id: "element" }],
    previewAnnotations: [{ id: "annotation" }],
    reviewComments: [{ id: "review" }],
  };
  expect(composerDraftMatchesSend({ ...sent }, sent)).toBe(true);
  expect(composerDraftMatchesSend(undefined, sent)).toBe(false);
  expect(composerDraftMatchesSend({ ...sent, prompt: "New draft" }, sent)).toBe(false);
  for (const key of [
    "images",
    "terminalContexts",
    "elementContexts",
    "previewAnnotations",
    "reviewComments",
  ] as const) {
    expect(composerDraftMatchesSend({ ...sent, [key]: [] }, sent)).toBe(false);
    expect(
      composerDraftMatchesSend({ ...sent, [key]: [{ ...sent[key][0], text: "edited" }] }, sent),
    ).toBe(false);
  }
});
