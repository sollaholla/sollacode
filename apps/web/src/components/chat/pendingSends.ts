import type { DeferredThreadCommandEntry } from "@t3tools/client-runtime/platform";
import type { CommandId, ThreadId } from "@t3tools/contracts";
import { isHeldMessageId } from "@t3tools/shared/heldMessages";
import type { ChatMessage } from "../../types";

export interface ComposerSendContent {
  readonly prompt: string;
  readonly images: readonly unknown[];
  readonly terminalContexts: readonly unknown[];
  readonly elementContexts: readonly unknown[];
  readonly previewAnnotations: readonly unknown[];
  readonly reviewComments: readonly unknown[];
}

/** Draft entries are immutable. A delayed send must preserve edits made meanwhile. */
export function composerDraftMatchesSend(
  current: ComposerSendContent | null | undefined,
  sent: ComposerSendContent,
): boolean {
  if (!current || current.prompt !== sent.prompt) return false;
  return (
    [
      "images",
      "terminalContexts",
      "elementContexts",
      "previewAnnotations",
      "reviewComments",
    ] as const
  ).every(
    (key) =>
      current[key].length === sent[key].length &&
      current[key].every((entry, index) => entry === sent[key][index]),
  );
}

/** Recovered upload bytes are self-contained; blob URLs cannot survive a reload. */
export function pendingSendMessages(
  entries: readonly DeferredThreadCommandEntry[],
  threadId: ThreadId,
): ChatMessage[] {
  return entries.flatMap(({ command, error }) => {
    if (command.type !== "thread.turn.start" || command.threadId !== threadId || error) return [];
    // A queued send never belongs in the timeline: the outbox chip shows it
    // until the server stores it, and the queue panel from then on. Echoing it
    // here showed it as "Sending…" beside its own queue row, and kept showing
    // it after it was edited or removed from the queue.
    if (isHeldMessageId(command.message.messageId)) return [];
    return [
      {
        id: command.message.messageId,
        role: "user" as const,
        text: command.message.text,
        ...(command.message.inputOrigin ? { inputOrigin: command.message.inputOrigin } : {}),
        attachments: command.message.attachments.map(({ dataUrl, ...attachment }, index) => ({
          ...attachment,
          id: `${command.message.messageId}:${index}`,
          previewUrl: dataUrl,
        })),
        createdAt: command.createdAt,
        updatedAt: command.createdAt,
        turnId: null,
        streaming: false,
      },
    ];
  });
}

/**
 * Accepted sends whose message the server now stores, so their local echo can
 * be released. Stored means any state, including a queued message the
 * timeline hides and one already removed from the queue: matching only the
 * messages on screen never released those, and the outbox kept them forever.
 */
export function acknowledgeableSendCommandIds(
  entries: readonly DeferredThreadCommandEntry[],
  storedMessageIds: ReadonlySet<string>,
): CommandId[] {
  return entries.flatMap((entry) =>
    entry.accepted &&
    entry.command.type === "thread.turn.start" &&
    storedMessageIds.has(entry.command.message.messageId)
      ? [entry.command.commandId]
      : [],
  );
}
