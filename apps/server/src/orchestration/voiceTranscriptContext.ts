import { isOrchestratorThreadId, type OrchestrationMessage } from "@t3tools/contracts";

/**
 * Folds the orchestrator's spoken conversation into the next text turn.
 *
 * Voice exchanges are recorded as turn-less `voiceTranscript` message rows, so
 * the projected thread shows one continuous conversation — but the text
 * provider's CLI session only ever receives the prompts delivered to it. Left
 * alone, typing after a spoken exchange would hit an agent that never heard any
 * of it. This prefixes the undelivered spoken turns to the outgoing prompt, the
 * same trick the provider-handoff digest uses.
 *
 * "Undelivered" is bounded by the last delivered PROMPT — the newest non-voice
 * user message: every earlier voice row was folded into that prompt's digest
 * when it went out, and everything after it has, by construction, never
 * reached the provider. Anchoring on the assistant reply instead would lose
 * utterances spoken between prompt delivery and the reply's first token (a
 * window that spans CLI spawn and long tool calls). The cost of this anchor is
 * that an interrupted turn may digest a row twice — rare, bounded, and
 * strictly better than the agent losing the exchange.
 */

const MAX_VOICE_DIGEST_CHARS = 6_000;
const OMISSION_NOTE = "[Earlier spoken turns omitted to stay within budget.]";

export interface VoiceTranscriptTurnInput {
  readonly threadId: string;
  readonly messages: ReadonlyArray<OrchestrationMessage>;
  /** The message being delivered right now — excluded from the digest. */
  readonly outgoingMessageId: string | undefined;
  readonly outgoingText: string;
}

export function buildVoiceTranscriptTurnInput(input: VoiceTranscriptTurnInput): string | null {
  if (!isOrchestratorThreadId(input.threadId)) {
    return null;
  }

  // The message being delivered right now is already projected by the time the
  // reactor builds the request; identify it by id, falling back to the same
  // tail text match the provider-handoff digest uses when no id was threaded.
  const isOutgoingMessage = (message: OrchestrationMessage, index: number): boolean =>
    input.outgoingMessageId !== undefined
      ? message.id === input.outgoingMessageId
      : index === input.messages.length - 1 &&
        message.role === "user" &&
        message.text === input.outgoingText;

  let boundary = -1;
  for (let index = input.messages.length - 1; index >= 0; index -= 1) {
    const message = input.messages[index];
    if (
      message !== undefined &&
      message.role === "user" &&
      message.voiceTranscript !== true &&
      !isOutgoingMessage(message, index)
    ) {
      boundary = index;
      break;
    }
  }

  const spoken = input.messages
    .slice(boundary + 1)
    .filter(
      (message, offset) =>
        message.voiceTranscript === true &&
        !isOutgoingMessage(message, boundary + 1 + offset) &&
        message.text.trim().length > 0,
    );
  if (spoken.length === 0) {
    return null;
  }

  const lines = spoken.map(
    (message) =>
      `${message.role === "user" ? "User (spoken)" : "Orchestrator (spoken)"}: ${message.text}`,
  );

  // Budget from the newest line backwards: the tail of a conversation is worth
  // more than its opening when something has to go.
  const kept: Array<string> = [];
  let total = 0;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (line === undefined) continue;
    if (total + line.length > MAX_VOICE_DIGEST_CHARS && kept.length > 0) {
      kept.unshift(OMISSION_NOTE);
      break;
    }
    kept.unshift(line);
    total += line.length;
  }

  return [
    "[Voice conversation] Since your last reply the user spoke with this workspace's voice orchestrator. Treat the transcript below as part of this conversation and continue from it:",
    ...kept,
    "[End of voice conversation]",
    "",
    input.outgoingText,
  ].join("\n");
}
