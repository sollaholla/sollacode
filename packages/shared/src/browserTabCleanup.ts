import { CommandId, MessageId, TurnId } from "@t3tools/contracts";

import { AGENT_STOP_TOKEN } from "./agentMode.ts";

const BROWSER_TAB_CLEANUP_MESSAGE_ID_PREFIX = "browser-tab-cleanup-message:";

export const browserTabCleanupIds = (input: {
  readonly threadId: string;
  readonly completedTurnId: string;
}): { readonly commandId: CommandId; readonly messageId: MessageId } => {
  const key = `${input.threadId}:${input.completedTurnId}`;
  return {
    commandId: CommandId.make(`browser-tab-cleanup-command:${key}`),
    messageId: MessageId.make(`${BROWSER_TAB_CLEANUP_MESSAGE_ID_PREFIX}${key}`),
  };
};

export const isBrowserTabCleanupMessageId = (messageId: string): boolean =>
  messageId.startsWith(BROWSER_TAB_CLEANUP_MESSAGE_ID_PREFIX);

export const browserTabCleanupSourceTurnId = (input: {
  readonly threadId: string;
  readonly messageId: string;
}): TurnId | null => {
  const prefix = `${BROWSER_TAB_CLEANUP_MESSAGE_ID_PREFIX}${input.threadId}:`;
  if (!input.messageId.startsWith(prefix)) return null;
  const sourceTurnId = input.messageId.slice(prefix.length);
  return sourceTurnId.length > 0 ? TurnId.make(sourceTurnId) : null;
};

export const browserTabCleanupPrompt = (
  tabCount: number,
  options?: { readonly agentMode?: boolean },
): string =>
  [
    `Browser tab check: ${tabCount} ${tabCount === 1 ? "tab is" : "tabs are"} open.`,
    "Review the preview_open results from your work and clean up any tabs that a preview_open call reported as newly created and that you no longer need by calling preview_close.",
    "Never close a reused tab or a user-owned tab merely as cleanup. Keep tabs that are still needed for the ongoing task.",
    // In Agent mode this housekeeping turn would otherwise count as fresh work
    // and re-trigger the autonomous continuation loop after it completes.
    ...(options?.agentMode === true
      ? [
          `This is automated housekeeping, not new work from the user: after the cleanup pass (even if you close nothing), end your message with \`${AGENT_STOP_TOKEN}\` on a new line by itself so this check does not re-trigger autonomous work.`,
        ]
      : []),
  ].join(" ");

export const normalizeBrowserTabSet = (tabIds: ReadonlyArray<string>): ReadonlyArray<string> =>
  [...new Set(tabIds)].toSorted();

export type BrowserTabCleanupDecision =
  | { readonly _tag: "RecordCurrent" }
  | { readonly _tag: "SendReminder"; readonly tabCount: number };

/**
 * Decides whether a completed provider turn needs one browser cleanup pass.
 *
 * The baseline is deliberately unknown on upgrade/recovery: the first
 * completion records what exists without blaming that turn for older tabs.
 * A cleanup turn records the post-cleanup set and can therefore never prompt
 * itself recursively.
 */
export const decideBrowserTabCleanup = (input: {
  readonly baseline: {
    readonly tabIds: ReadonlyArray<string>;
  } | null;
  readonly currentTabIds: ReadonlyArray<string>;
  readonly sourceMessageId: string | null;
}): BrowserTabCleanupDecision => {
  if (input.sourceMessageId !== null && isBrowserTabCleanupMessageId(input.sourceMessageId)) {
    return { _tag: "RecordCurrent" };
  }
  if (input.baseline === null) {
    return { _tag: "RecordCurrent" };
  }

  const baselineTabIds = normalizeBrowserTabSet(input.baseline.tabIds);
  const currentTabIds = normalizeBrowserTabSet(input.currentTabIds);
  // Nothing open is nothing to clean up. A turn that closed the last tab still
  // changes the set, so without this the reminder fired on an empty browser and
  // asked for a cleanup pass that had no possible subject.
  if (currentTabIds.length === 0) {
    return { _tag: "RecordCurrent" };
  }
  if (
    baselineTabIds.length === currentTabIds.length &&
    baselineTabIds.every((tabId, index) => tabId === currentTabIds[index])
  ) {
    return { _tag: "RecordCurrent" };
  }
  return { _tag: "SendReminder", tabCount: currentTabIds.length };
};
