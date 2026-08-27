export interface ThreadComposerPrimaryAction {
  readonly canSend: boolean;
  readonly sendLabel: string;
  readonly showStopAction: boolean;
}

export function resolveThreadComposerPrimaryAction(input: {
  readonly activeThreadBusy: boolean;
  readonly connectionConnected: boolean;
  readonly hasContent: boolean;
  readonly hasQueuedSendNow: boolean;
  readonly queueCount: number;
}): ThreadComposerPrimaryAction {
  if (input.hasQueuedSendNow && !input.hasContent) {
    return {
      canSend: true,
      sendLabel: "Send all queued messages now",
      showStopAction: false,
    };
  }

  return {
    canSend: input.hasContent,
    sendLabel:
      !input.connectionConnected || input.activeThreadBusy || input.queueCount > 0
        ? "Queue"
        : "Send",
    showStopAction: input.activeThreadBusy,
  };
}
