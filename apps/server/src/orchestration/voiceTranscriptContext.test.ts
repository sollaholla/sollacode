import {
  MessageId,
  ORCHESTRATOR_THREAD_ID,
  TurnId,
  type OrchestrationMessage,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildVoiceTranscriptTurnInput } from "./voiceTranscriptContext.ts";

const NOW = "2026-01-01T00:00:00.000Z";

let messageCounter = 0;
function message(input: {
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly turnId?: string | null;
  readonly voiceTranscript?: boolean;
}): OrchestrationMessage {
  messageCounter += 1;
  return {
    id: MessageId.make(`m-${messageCounter}`),
    role: input.role,
    text: input.text,
    turnId: input.turnId == null ? null : TurnId.make(input.turnId),
    ...(input.voiceTranscript === true ? { voiceTranscript: true } : {}),
    streaming: false,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

describe("buildVoiceTranscriptTurnInput", () => {
  it("returns null for ordinary threads no matter the messages", () => {
    expect(
      buildVoiceTranscriptTurnInput({
        threadId: "thread-ordinary",
        messages: [message({ role: "user", text: "spoken", voiceTranscript: true })],
        outgoingMessageId: undefined,
        outgoingText: "typed",
      }),
    ).toBeNull();
  });

  it("returns null when nothing was spoken since the last provider reply", () => {
    expect(
      buildVoiceTranscriptTurnInput({
        threadId: ORCHESTRATOR_THREAD_ID,
        messages: [
          message({ role: "user", text: "typed question" }),
          message({ role: "assistant", text: "typed answer", turnId: "turn-1" }),
        ],
        outgoingMessageId: undefined,
        outgoingText: "another typed question",
      }),
    ).toBeNull();
  });

  it("prefixes the spoken conversation onto the outgoing prompt", () => {
    const outgoing = message({ role: "user", text: "typed follow-up" });
    const input = buildVoiceTranscriptTurnInput({
      threadId: ORCHESTRATOR_THREAD_ID,
      messages: [
        message({ role: "assistant", text: "typed answer", turnId: "turn-1" }),
        message({ role: "user", text: "how is rover?", voiceTranscript: true }),
        message({ role: "assistant", text: "Rover is building.", voiceTranscript: true }),
        outgoing,
      ],
      outgoingMessageId: outgoing.id,
      outgoingText: "typed follow-up",
    });
    expect(input).not.toBeNull();
    expect(input).toContain("User (spoken): how is rover?");
    expect(input).toContain("Orchestrator (spoken): Rover is building.");
    // The typed message itself must arrive after the transcript, unchanged.
    expect(input?.endsWith("typed follow-up")).toBe(true);
    // The outgoing message must not be duplicated into the transcript block.
    expect(input?.indexOf("typed follow-up")).toBe(input?.lastIndexOf("typed follow-up"));
  });

  it("only includes speech after the newest delivered prompt", () => {
    const input = buildVoiceTranscriptTurnInput({
      threadId: ORCHESTRATOR_THREAD_ID,
      messages: [
        message({ role: "user", text: "old spoken", voiceTranscript: true }),
        message({ role: "user", text: "typed prompt" }),
        message({ role: "assistant", text: "provider reply", turnId: "turn-1" }),
        message({ role: "user", text: "new spoken", voiceTranscript: true }),
      ],
      outgoingMessageId: undefined,
      outgoingText: "typed",
    });
    // "old spoken" was already digested into "typed prompt" when it went out;
    // repeating it every turn would grow without bound.
    expect(input).toContain("new spoken");
    expect(input).not.toContain("old spoken");
  });

  it("keeps utterances spoken between prompt delivery and the reply's first token", () => {
    // The assistant row for a turn is only created at its first streaming
    // delta, which can lag the prompt by CLI-spawn seconds or a long tool
    // call. Speech in that window lands BEFORE the reply row; anchoring the
    // boundary on the reply would drop it forever.
    const input = buildVoiceTranscriptTurnInput({
      threadId: ORCHESTRATOR_THREAD_ID,
      messages: [
        message({ role: "user", text: "typed prompt" }),
        message({ role: "user", text: "spoken while spinning up", voiceTranscript: true }),
        message({ role: "assistant", text: "provider reply", turnId: "turn-1" }),
      ],
      outgoingMessageId: undefined,
      outgoingText: "typed follow-up",
    });
    expect(input).toContain("spoken while spinning up");
  });

  it("ignores turn-less messages that are not voice transcripts", () => {
    // Ordinary typed user messages are also turn-less rows; only the explicit
    // voiceTranscript flag may select entries, or every typed message would be
    // duplicated into its own prompt.
    const outgoing = message({ role: "user", text: "typed" });
    expect(
      buildVoiceTranscriptTurnInput({
        threadId: ORCHESTRATOR_THREAD_ID,
        messages: [message({ role: "user", text: "earlier typed message" }), outgoing],
        outgoingMessageId: outgoing.id,
        outgoingText: "typed",
      }),
    ).toBeNull();
  });

  it("keeps the newest lines when the transcript exceeds its budget", () => {
    const filler = "y".repeat(3_500);
    const input = buildVoiceTranscriptTurnInput({
      threadId: ORCHESTRATOR_THREAD_ID,
      messages: [
        message({ role: "user", text: `oldest ${filler}`, voiceTranscript: true }),
        message({ role: "user", text: `middle ${filler}`, voiceTranscript: true }),
        message({ role: "assistant", text: "newest short reply", voiceTranscript: true }),
      ],
      outgoingMessageId: undefined,
      outgoingText: "typed",
    });
    expect(input).toContain("newest short reply");
    expect(input).not.toContain("oldest");
    expect(input).toContain("omitted");
  });
});
