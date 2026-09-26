import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import {
  CommandId,
  MessageId,
  ThreadId,
  type ClientOrchestrationCommand,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { ServerConfig } from "../config.ts";
import { resolveAttachmentPath } from "../attachmentStore.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import { voiceWavFixture } from "../voiceNote.test-fixture.ts";
import { normalizeDispatchCommand } from "./Normalizer.ts";

const native = vi.hoisted(() => vi.fn());
vi.mock("@t3tools/shared/nativeVoice/MacSpeechTranscription", () => ({
  transcribeMacVoice: native,
}));
vi.mock("@t3tools/shared/nativeVoice/WindowsSpeechTranscription", () => ({
  transcribeWindowsVoice: native,
}));
vi.mock("../voiceNoteMlxRuntime.ts", () => ({
  resolveVoiceMlxRuntime: () => Promise.resolve(null),
}));

function recordedVoiceFixture() {
  const bytes = voiceWavFixture();
  new DataView(bytes.buffer).setInt16(44, 1, true);
  return bytes;
}

function command(): ClientOrchestrationCommand {
  const bytes = recordedVoiceFixture();
  return {
    type: "thread.turn.start",
    commandId: CommandId.make("voice-command"),
    threadId: ThreadId.make("voice-thread"),
    message: {
      messageId: MessageId.make("voice-message"),
      role: "user",
      text: "Additional typed instruction.",
      attachments: [
        {
          type: "audio",
          name: "Voice note.wav",
          mimeType: "audio/wav",
          sizeBytes: bytes.length,
          durationMs: 100_000,
          dataUrl: `data:audio/wav;base64,${Buffer.from(bytes).toString("base64")}`,
        },
      ],
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    createdAt: "2026-09-13T00:00:00.000Z",
  };
}
const testLayer = Layer.mergeAll(
  ServerConfig.layerTest(process.cwd(), { prefix: "solla-voice-normalizer-" }),
  WorkspacePaths.layer,
).pipe(Layer.provideMerge(NodeServices.layer));

describe("voice note command normalization", () => {
  it.effect("stores the recording and host transcript while retaining separate typed text", () =>
    Effect.gen(function* () {
      native.mockResolvedValue({ status: "success", text: "Spoken instruction." });
      const result = yield* normalizeDispatchCommand(command());
      if (result.type !== "thread.turn.start") throw new Error("Expected turn command");
      expect(result.message.text).toBe("Additional typed instruction.");
      expect(result.message.inputOrigin).toBe("transcription");
      const note = result.message.attachments[0];
      expect(note).toMatchObject({
        type: "audio",
        durationMs: 1000,
        transcript: "Spoken instruction.",
      });
      if (!note) throw new Error("Missing voice note");
      const { attachmentsDir } = yield* ServerConfig;
      const path = resolveAttachmentPath({ attachmentsDir, attachment: note });
      if (!path) throw new Error("Missing persisted audio path");
      const fs = yield* FileSystem.FileSystem;
      expect(Array.from(yield* fs.readFile(path))).toEqual(Array.from(recordedVoiceFixture()));
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("rejects a failed transcription before creating a turn", () =>
    Effect.gen(function* () {
      native.mockRejectedValue(new Error("Speech service unavailable"));
      const failure = yield* normalizeDispatchCommand(command()).pipe(Effect.flip);
      expect(failure.message).toContain("Speech service unavailable");
    }).pipe(Effect.provide(testLayer)),
  );
});
