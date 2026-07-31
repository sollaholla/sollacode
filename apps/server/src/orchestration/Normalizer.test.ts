import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  CommandId,
  type ClientOrchestrationCommand,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import { resolveAttachmentPath } from "../attachmentStore.ts";
import { ServerConfig } from "../config.ts";
import { HEIC_FIXTURE_BASE64 } from "../modelImageCompatibility.test-fixture.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import {
  canonicalizeClientCommandTimestamps,
  isSendImagePayloadByteLengthValid,
  normalizeDispatchCommand,
} from "./Normalizer.ts";

const clientCreatedAt = "2031-01-01T00:00:00.000Z";
const serverReceivedAt = "2026-07-18T00:00:00.000Z";

describe("canonicalizeClientCommandTimestamps", () => {
  it("replaces a client command timestamp with the server receipt timestamp", () => {
    const command: ClientOrchestrationCommand = {
      type: "project.create",
      commandId: CommandId.make("command-1"),
      projectId: ProjectId.make("project-1"),
      title: "Clock-safe project",
      workspaceRoot: "/tmp/clock-safe-project",
      createdAt: clientCreatedAt,
    };

    expect(canonicalizeClientCommandTimestamps(command, serverReceivedAt)).toEqual({
      ...command,
      createdAt: serverReceivedAt,
    });
  });

  it("replaces both timestamps when the first turn bootstraps a thread", () => {
    const command: ClientOrchestrationCommand = {
      type: "thread.turn.start",
      commandId: CommandId.make("command-2"),
      threadId: ThreadId.make("thread-1"),
      message: {
        messageId: MessageId.make("message-1"),
        role: "user",
        text: "Start a thread",
        attachments: [],
      },
      runtimeMode: "full-access",
      interactionMode: "default",
      bootstrap: {
        createThread: {
          projectId: ProjectId.make("project-1"),
          title: "Clock-safe thread",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5.4",
          },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt: clientCreatedAt,
        },
      },
      createdAt: clientCreatedAt,
    };

    const result = canonicalizeClientCommandTimestamps(command, serverReceivedAt);

    expect(result.type).toBe("thread.turn.start");
    if (result.type !== "thread.turn.start") {
      throw new Error("Expected a thread.turn.start command");
    }
    expect(result.createdAt).toBe(serverReceivedAt);
    expect(result.bootstrap?.createThread?.createdAt).toBe(serverReceivedAt);
  });
});

describe("isSendImagePayloadByteLengthValid", () => {
  it("accepts one byte below 2 MiB and rejects the exact boundary", () => {
    expect(PROVIDER_SEND_TURN_MAX_IMAGE_BYTES).toBe(2 * 1024 * 1024 - 1);
    expect(isSendImagePayloadByteLengthValid(PROVIDER_SEND_TURN_MAX_IMAGE_BYTES)).toBe(true);
    expect(isSendImagePayloadByteLengthValid(2 * 1024 * 1024)).toBe(false);
  });

  it("rejects empty payloads", () => {
    expect(isSendImagePayloadByteLengthValid(0)).toBe(false);
  });
});

describe("normalizeDispatchCommand image compatibility", () => {
  it.effect("persists HEIC uploads as JPEG before a provider turn is created", () => {
    const heicBytes = Buffer.from(HEIC_FIXTURE_BASE64, "base64");
    const command: ClientOrchestrationCommand = {
      type: "thread.turn.start",
      commandId: CommandId.make("command-heic"),
      threadId: ThreadId.make("thread-heic"),
      message: {
        messageId: MessageId.make("message-heic"),
        role: "user",
        text: "Inspect this photo",
        attachments: [
          {
            type: "image",
            name: "FullSizeRender.heic",
            mimeType: "image/heic",
            sizeBytes: heicBytes.byteLength,
            dataUrl: `data:image/heic;base64,${HEIC_FIXTURE_BASE64}`,
          },
        ],
      },
      runtimeMode: "full-access",
      interactionMode: "default",
      createdAt: clientCreatedAt,
    };
    const testLayer = Layer.mergeAll(
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-normalizer-heic-test-" }),
      WorkspacePaths.layer,
    ).pipe(Layer.provideMerge(NodeServices.layer));

    return Effect.gen(function* () {
      const normalized = yield* normalizeDispatchCommand(command);
      if (normalized.type !== "thread.turn.start") {
        throw new Error("Expected a normalized thread.turn.start command");
      }
      const attachment = normalized.message.attachments[0];
      if (!attachment) {
        throw new Error("Expected a normalized attachment");
      }
      const { attachmentsDir } = yield* ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const attachmentPath = resolveAttachmentPath({ attachmentsDir, attachment });
      if (!attachmentPath) {
        throw new Error("Expected a persisted attachment path");
      }
      const bytes = yield* fileSystem.readFile(attachmentPath);
      expect(attachment.name).toBe("FullSizeRender.jpg");
      expect(attachment.mimeType).toBe("image/jpeg");
      expect(attachment.sizeBytes).toBe(bytes.byteLength);
      expect(Array.from(bytes.slice(0, 3))).toEqual([0xff, 0xd8, 0xff]);
    }).pipe(Effect.provide(testLayer));
  });
});
