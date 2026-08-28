export interface ThreadComposerPrimaryAction {
  readonly canSend: boolean;
  readonly canPromoteQueued: boolean;
  readonly queuedPromotionLabel: string;
  readonly sendLabel: string;
  readonly showQueuedPromotionAction: boolean;
  readonly showStopAction: boolean;
}

export function resolveThreadComposerSubmitAction(input: {
  readonly hasContent: boolean;
  readonly hasQueuedSendNow: boolean;
}): "promote-queued" | "send-draft" | null {
  if (input.hasContent) return "send-draft";
  return input.hasQueuedSendNow ? "promote-queued" : null;
}

export function resolveThreadComposerPrimaryAction(input: {
  readonly activeThreadBusy: boolean;
  readonly connectionConnected: boolean;
  readonly hasContent: boolean;
  readonly hasQueuedSendNow: boolean;
  readonly isPromotingQueued: boolean;
  readonly queueCount: number;
}): ThreadComposerPrimaryAction {
  return {
    canSend: input.hasContent,
    canPromoteQueued:
      input.hasQueuedSendNow && input.connectionConnected && !input.isPromotingQueued,
    queuedPromotionLabel: input.isPromotingQueued ? "Sending queued messages" : "Send queued now",
    sendLabel:
      !input.connectionConnected || input.activeThreadBusy || input.queueCount > 0
        ? "Queue"
        : "Send",
    showQueuedPromotionAction: input.hasQueuedSendNow,
    showStopAction: input.activeThreadBusy,
  };
}
