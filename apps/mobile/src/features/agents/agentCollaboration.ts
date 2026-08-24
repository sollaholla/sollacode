import type {
  VmAgentCollaborationIdentitySummary,
  VmAgentDelegation,
  VmAgentDelegationListItem,
  VmAgentDelegationMessage,
  VmAgentDelegationStatus,
} from "@t3tools/contracts";

export function isDelegationRelatedToAgent(
  delegation: Pick<VmAgentDelegation, "rootVmAgentId" | "sourceVmAgentId" | "targetVmAgentId">,
  vmAgentId: string,
): boolean {
  return (
    delegation.rootVmAgentId === vmAgentId ||
    delegation.sourceVmAgentId === vmAgentId ||
    delegation.targetVmAgentId === vmAgentId
  );
}

export function delegationFollowupKind(status: VmAgentDelegationStatus): "answer" | "note" {
  return status === "waiting-input" ? "answer" : "note";
}

export function delegationDirectionLabel(
  summary: {
    readonly delegation: Pick<
      VmAgentDelegationListItem,
      "targetVmAgentId" | "target" | "sourceAgentSnapshot" | "targetAgentSnapshot"
    >;
    readonly sourceAgent: Pick<VmAgentCollaborationIdentitySummary, "name"> | null;
    readonly targetAgent: Pick<VmAgentCollaborationIdentitySummary, "name"> | null;
  },
  vmAgentId: string,
): string {
  if (summary.delegation.targetVmAgentId === vmAgentId) {
    return `from ${summary.sourceAgent?.name ?? summary.delegation.sourceAgentSnapshot.name}`;
  }
  if (summary.delegation.target.kind === "ephemeral") {
    return `to ${summary.delegation.target.label ?? "One-off helper"}`;
  }
  return `to ${
    summary.targetAgent?.name ??
    summary.delegation.targetAgentSnapshot?.name ??
    `Agent ${summary.delegation.target.vmAgentId}`
  }`;
}

export function emptyDelegationListMessage(hasMoreDelegations: boolean): string {
  return hasMoreDelegations
    ? "Some older handoffs are outside this bounded live view."
    : "No delegated work yet. The root can create a named or ephemeral collaborator through chat.";
}

export function boundedCollaborationPreview(
  text: string,
  options: { readonly maxCharacters?: number; readonly maxLines?: number } = {},
): { readonly text: string; readonly truncated: boolean } {
  const maxCharacters = Math.max(1, options.maxCharacters ?? 600);
  const maxLines = Math.max(1, options.maxLines ?? 6);
  const lines = text.split("\n");
  const lineBounded = lines.slice(0, maxLines).join("\n");
  const truncated = lines.length > maxLines || lineBounded.length > maxCharacters;
  let end = Math.min(lineBounded.length, truncated ? maxCharacters - 1 : maxCharacters);
  const lastCodeUnit = lineBounded.charCodeAt(end - 1);
  if (lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff) end -= 1;
  const visible = lineBounded.slice(0, end);
  return { text: truncated ? `${visible.trimEnd()}…` : visible, truncated };
}

export function mergeCollaborationMessages(
  ...pages: ReadonlyArray<ReadonlyArray<VmAgentDelegationMessage>>
): ReadonlyArray<VmAgentDelegationMessage> {
  const messagesBySequence = new Map<number, VmAgentDelegationMessage>();
  for (const page of pages) {
    for (const message of page) messagesBySequence.set(message.sequence, message);
  }
  return Array.from(messagesBySequence.values()).sort(
    (left, right) => left.sequence - right.sequence,
  );
}

export function hasEarlierCollaborationMessages(
  serverValue: boolean | undefined,
  messageCount: number,
  loadedMessageCount: number,
): boolean {
  if (serverValue === false) return false;
  return messageCount > loadedMessageCount;
}

export function hasEarlierAfterCollaborationPage(input: {
  readonly beforeSequence: number;
  readonly page: ReadonlyArray<VmAgentDelegationMessage>;
  readonly mergedMessageCount: number;
  readonly totalMessageCount: number;
  readonly serverValue: boolean | undefined;
}): boolean {
  const cursorAdvanced = input.page.some((message) => message.sequence < input.beforeSequence);
  if (!cursorAdvanced) return false;
  return input.serverValue ?? input.totalMessageCount > input.mergedMessageCount;
}
