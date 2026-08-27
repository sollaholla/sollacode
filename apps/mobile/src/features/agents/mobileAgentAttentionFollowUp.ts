import { mergeWaitingOnYouFollowUpDraft } from "@t3tools/shared/agentAttentionFollowUp";

export async function openMobileWaitingOnYouFollowUp(input: {
  readonly blockerTitle: string;
  readonly draftKey: string;
  readonly environmentId: string;
  readonly threadId: string;
  readonly transformDraftText: (
    draftKey: string,
    transform: (current: string) => string,
  ) => Promise<void>;
  readonly requestFocus: (draftKey: string) => void;
  readonly navigate: (params: {
    readonly environmentId: string;
    readonly threadId: string;
  }) => void;
}): Promise<void> {
  await input.transformDraftText(input.draftKey, (current) =>
    mergeWaitingOnYouFollowUpDraft(current, input.blockerTitle),
  );
  input.requestFocus(input.draftKey);
  input.navigate({ environmentId: input.environmentId, threadId: input.threadId });
}
