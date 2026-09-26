import type { DeferredThreadCommandEntry } from "@t3tools/client-runtime/platform";
import type { ThreadId } from "@t3tools/contracts";
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
