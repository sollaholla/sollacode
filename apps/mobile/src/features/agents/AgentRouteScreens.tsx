import { useAtomValue } from "@effect/atom-react";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import {
  EnvironmentId,
  type VmAgent,
  type VmAgentAttentionSummary,
  type VmAgentCollaborationSnapshot,
  type VmAgentDelegationMessage,
  type VmAgentDelegationStatus,
  type VmAgentDelegationSummary,
  type VmAgentNotification,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/unstable/reactivity";
import { useEffect, useMemo, useRef, useState } from "react";
import { Alert, Pressable, ScrollView, View } from "react-native";

import { AppText as Text, AppTextInput as TextInput } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import { EmptyState } from "../../components/EmptyState";
import { useEnvironments } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { vmAgentEnvironment } from "../../state/vmAgents";
import { MarkdownDocument } from "../files/FileMarkdownPreview";
import {
  boundedCollaborationPreview,
  delegationDirectionLabel,
  delegationFollowupKind,
  emptyDelegationListMessage,
  hasEarlierAfterCollaborationPage,
  hasEarlierCollaborationMessages,
  isDelegationRelatedToAgent,
  mergeCollaborationMessages,
} from "./agentCollaboration";

const TERMINAL_STATUSES = new Set<VmAgentDelegationStatus>([
  "completed",
  "failed",
  "cancelled",
  "expired",
]);

function statusTone(status: string): string {
  if (status === "running" || status === "available" || status === "completed") {
    return "bg-emerald-500/12 text-emerald-700 dark:text-emerald-300";
  }
  if (status === "failed" || status === "expired") {
    return "bg-red-500/12 text-red-700 dark:text-red-300";
  }
  if (status === "waiting-input" || status === "pending-approval") {
    return "bg-amber-500/12 text-amber-700 dark:text-amber-300";
  }
  return "bg-subtle text-foreground-muted";
}

function StatusChip({ value }: { readonly value: string }) {
  return (
    <View className={`max-w-full shrink-0 rounded-full px-2 py-1 ${statusTone(value)}`}>
      <Text className="text-2xs font-t3-bold" numberOfLines={1}>
        {value}
      </Text>
    </View>
  );
}

function AgentAttentionIndicators(props: { readonly attention: VmAgentAttentionSummary | null }) {
  if (!props.attention) return null;
  return (
    <View className="shrink-0 flex-row items-center gap-1.5">
      {props.attention.openBlockerCount > 0 ? (
        <View
          accessibilityLabel={`${props.attention.openBlockerCount} waiting on you`}
          className="size-8 items-center justify-center rounded-full bg-amber-500/12"
        >
          <SymbolView name="hand.raised.fill" size={17} tintColor="#d97706" />
        </View>
      ) : null}
      {props.attention.unreadNotificationCount > 0 ? (
        <View
          accessibilityLabel={`${props.attention.unreadNotificationCount} unread notifications`}
          className="min-h-8 min-w-8 flex-row items-center justify-center gap-1 rounded-full bg-primary px-2"
        >
          <SymbolView name="bell.badge.fill" size={14} tintColor="#ffffff" />
          <Text className="text-xs font-t3-bold text-primary-foreground">
            {props.attention.unreadNotificationCount}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

function AgentEnvironmentSection(props: {
  readonly environmentId: EnvironmentId;
  readonly label: string;
}) {
  const navigation = useNavigation();
  const agentsAtom = useMemo(
    () => vmAgentEnvironment.agents({ environmentId: props.environmentId, input: {} }),
    [props.environmentId],
  );
  const result = useAtomValue(agentsAtom);
  const collaborationAtom = useMemo(
    () => vmAgentEnvironment.collaboration({ environmentId: props.environmentId, input: {} }),
    [props.environmentId],
  );
  const collaborationResult = useAtomValue(collaborationAtom);
  const attentionAtom = useMemo(
    () => vmAgentEnvironment.attention({ environmentId: props.environmentId, input: {} }),
    [props.environmentId],
  );
  const attentionResult = useAtomValue(attentionAtom);
  const latest = Option.getOrNull(AsyncResult.value(result));
  const agents = latest?.type === "snapshot" ? latest.agents : [];
  const collaborationItem = Option.getOrNull(AsyncResult.value(collaborationResult));
  const collaboration = collaborationItem?.type === "snapshot" ? collaborationItem : null;
  const attentionItem = Option.getOrNull(AsyncResult.value(attentionResult));
  const attention = attentionItem?.type === "snapshot" ? attentionItem.agents : [];

  return (
    <View className="min-w-0 gap-2">
      <Text className="px-1 text-xs font-t3-bold uppercase text-foreground-muted" numberOfLines={1}>
        {props.label}
      </Text>
      {result._tag === "Failure" ? (
        <View className="rounded-2xl border border-red-500/25 bg-sheet p-4">
          <Text className="text-sm text-red-700 dark:text-red-300">
            Agents are unavailable while this host reconnects.
          </Text>
        </View>
      ) : latest?.type !== "snapshot" ? (
        <View className="rounded-2xl border border-border bg-sheet p-4">
          <Text className="text-sm text-foreground-muted">Loading agents…</Text>
        </View>
      ) : agents.length === 0 ? (
        <View className="rounded-2xl border border-border bg-sheet p-4">
          <Text className="text-sm text-foreground-muted">No named agents on this host.</Text>
        </View>
      ) : (
        agents.map((agent) => {
          const activeWork =
            collaboration?.agents.find((entry) => entry.vmAgentId === agent.vmAgentId)
              ?.activeDelegations ?? 0;
          const agentAttention =
            attention.find((entry) => entry.vmAgentId === agent.vmAgentId) ?? null;
          return (
            <Pressable
              key={agent.vmAgentId}
              accessibilityLabel={`Open ${agent.name} on ${props.label}`}
              accessibilityRole="button"
              className="min-h-14 min-w-0 flex-row items-center gap-3 rounded-2xl border border-border bg-sheet px-4 py-3 active:bg-subtle"
              onPress={() =>
                navigation.navigate("Agent", {
                  environmentId: String(props.environmentId),
                  agentId: String(agent.vmAgentId),
                })
              }
            >
              <View className="size-10 shrink-0 items-center justify-center rounded-full bg-primary/10">
                <Text className="text-base font-t3-bold text-primary">
                  {agent.name.slice(0, 1).toUpperCase()}
                </Text>
              </View>
              <View className="min-w-0 flex-1">
                <Text className="text-base font-t3-bold text-foreground" numberOfLines={1}>
                  {agent.name}
                </Text>
                <Text className="text-sm text-foreground-muted" numberOfLines={2}>
                  {agent.purpose}
                </Text>
              </View>
              <AgentAttentionIndicators attention={agentAttention} />
              {activeWork > 0 ? <StatusChip value={`${activeWork} active`} /> : null}
              <StatusChip value={agent.status} />
            </Pressable>
          );
        })
      )}
    </View>
  );
}

export function AgentsRouteScreen() {
  const { environments, isReady } = useEnvironments();
  return (
    <ScrollView
      className="flex-1 bg-screen"
      contentInsetAdjustmentBehavior="automatic"
      showsHorizontalScrollIndicator={false}
      contentContainerClassName="min-w-0 gap-6 px-4 py-5"
    >
      <View className="min-w-0 gap-1">
        <Text className="text-2xl font-t3-bold text-foreground">Agents</Text>
        <Text className="text-sm text-foreground-muted">
          Named agents are grouped by the Mac or remote host that owns them.
        </Text>
      </View>
      {!isReady ? (
        <Text className="text-sm text-foreground-muted">Loading connected hosts…</Text>
      ) : environments.length === 0 ? (
        <EmptyState
          title="No connected hosts"
          detail="Connect an environment before opening its agents."
        />
      ) : (
        environments.map((environment) => (
          <AgentEnvironmentSection
            key={environment.environmentId}
            environmentId={environment.environmentId}
            label={environment.label}
          />
        ))
      )}
    </ScrollView>
  );
}

function relatedDelegations(
  snapshot: VmAgentCollaborationSnapshot | null,
  vmAgentId: string,
): ReadonlyArray<VmAgentDelegationSummary> {
  return (snapshot?.delegations ?? []).filter(({ delegation }) =>
    isDelegationRelatedToAgent(delegation, vmAgentId),
  );
}

function senderName(message: VmAgentDelegationMessage, summary: VmAgentDelegationSummary): string {
  if (message.sender === "user") return "You";
  if (message.sender === "system") return "System";
  if (message.sender === "source-agent") {
    return summary.sourceAgent?.name ?? summary.delegation.sourceAgentSnapshot.name;
  }
  return (
    summary.targetAgent?.name ?? summary.delegation.targetAgentSnapshot?.name ?? "Ephemeral worker"
  );
}

function MobileBoundedCollaborationText(props: {
  readonly text: string;
  readonly maxCharacters?: number;
  readonly maxLines?: number;
  readonly collapsedLabel: string;
  readonly textClassName?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const preview = useMemo(
    () =>
      boundedCollaborationPreview(props.text, {
        maxCharacters: props.maxCharacters,
        maxLines: props.maxLines,
      }),
    [props.maxCharacters, props.maxLines, props.text],
  );

  if (!preview.truncated) {
    return <Text className={props.textClassName ?? "text-sm text-foreground"}>{preview.text}</Text>;
  }

  return (
    <View className="min-w-0 gap-1.5">
      {expanded ? (
        <ScrollView
          className="max-h-64 min-w-0"
          nestedScrollEnabled
          showsHorizontalScrollIndicator={false}
          showsVerticalScrollIndicator
        >
          <Text className={props.textClassName ?? "text-sm text-foreground"}>{props.text}</Text>
        </ScrollView>
      ) : (
        <Text className={props.textClassName ?? "text-sm text-foreground"}>{preview.text}</Text>
      )}
      <Pressable
        accessibilityLabel={expanded ? "Collapse collaboration text" : props.collapsedLabel}
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        className="min-h-8 self-start justify-center rounded-lg px-1 active:opacity-70"
        onPress={() => setExpanded((current) => !current)}
      >
        <Text className="text-xs font-t3-bold text-primary">
          {expanded ? "Show less" : props.collapsedLabel}
        </Text>
      </Pressable>
    </View>
  );
}

interface LoadedDelegationHistory {
  readonly messages: ReadonlyArray<VmAgentDelegationMessage>;
  readonly hasEarlierMessages: boolean;
}

function sameMessageReferences(
  left: ReadonlyArray<VmAgentDelegationMessage>,
  right: ReadonlyArray<VmAgentDelegationMessage>,
): boolean {
  return left.length === right.length && left.every((message, index) => message === right[index]);
}

function CollaborationSection(props: {
  readonly environmentId: EnvironmentId;
  readonly agent: VmAgent;
  readonly onOpenChat: () => void;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [messageDrafts, setMessageDrafts] = useState<Record<string, string>>({});
  const [messageHistory, setMessageHistory] = useState<
    Readonly<Record<string, LoadedDelegationHistory>>
  >({});
  const [historyBeforeSequences, setHistoryBeforeSequences] = useState<
    Readonly<Record<string, number>>
  >({});
  const [pendingOperation, setPendingOperation] = useState<{
    readonly delegationId: string;
    readonly kind: "send" | "cancel";
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const collaborationAtom = useMemo(
    () => vmAgentEnvironment.collaboration({ environmentId: props.environmentId, input: {} }),
    [props.environmentId],
  );
  const collaborationQuery = useEnvironmentQuery(collaborationAtom);
  const item = collaborationQuery.data;
  const snapshot = item?.type === "snapshot" ? item : null;
  const delegations = relatedDelegations(snapshot, props.agent.vmAgentId);
  const collaborators =
    snapshot?.agents.filter((candidate) => candidate.vmAgentId !== props.agent.vmAgentId) ?? [];
  const hasMoreAgents = snapshot?.hasMoreAgents === true;
  const hasMoreDelegations = snapshot?.hasMoreDelegations === true;
  const selected =
    delegations.find((entry) => entry.delegation.delegationId === selectedId) ??
    delegations[0] ??
    null;
  const delegationId = selected?.delegation.delegationId ?? null;
  const detailAtom = useMemo(
    () =>
      delegationId
        ? vmAgentEnvironment.delegation({
            environmentId: props.environmentId,
            input: { delegationId },
          })
        : null,
    [delegationId, props.environmentId],
  );
  const detailQuery = useEnvironmentQuery(detailAtom);
  const detail = detailQuery.data;
  const historyBeforeSequence = delegationId
    ? (historyBeforeSequences[delegationId] ?? null)
    : null;
  const historyAtom = useMemo(
    () =>
      delegationId && historyBeforeSequence !== null
        ? vmAgentEnvironment.delegation({
            environmentId: props.environmentId,
            input: { delegationId, beforeSequence: historyBeforeSequence },
          })
        : null,
    [delegationId, historyBeforeSequence, props.environmentId],
  );
  const historyQuery = useEnvironmentQuery(historyAtom);
  const loadedHistory = delegationId ? messageHistory[delegationId] : undefined;
  const messages = useMemo(
    () => mergeCollaborationMessages(loadedHistory?.messages ?? [], detail?.messages ?? []),
    [detail?.messages, loadedHistory?.messages],
  );
  const hasEarlierMessages =
    loadedHistory?.hasEarlierMessages ??
    (detail
      ? hasEarlierCollaborationMessages(
          detail.hasEarlierMessages,
          detail.delegation.messageCount,
          messages.length,
        )
      : false);
  const oldestLoadedSequence = messages[0]?.sequence ?? null;
  const currentMessageDraft = delegationId ? (messageDrafts[delegationId] ?? "") : "";
  const waitingQuestion =
    [...messages].toReversed().find((message) => message.kind === "question") ??
    (selected?.latestMessage?.kind === "question" ? selected.latestMessage : null);
  const briefText = detail?.delegation.task ?? selected?.delegation.taskPreview.text ?? "";
  const resultText =
    detail?.delegation.result?.summary ?? selected?.delegation.resultPreview?.text ?? null;
  const delegationError =
    detail?.delegation.error ?? selected?.delegation.errorPreview?.text ?? null;
  const isSending =
    pendingOperation?.kind === "send" && pendingOperation.delegationId === delegationId;
  const isCancelling =
    pendingOperation?.kind === "cancel" && pendingOperation.delegationId === delegationId;
  const isLoadingEarlier = historyBeforeSequence !== null && historyQuery.isPending;
  const observedRevisions = useRef<Readonly<Record<string, number>>>({});
  const sendMessage = useAtomCommand(vmAgentEnvironment.sendDelegationMessage, {
    reportFailure: false,
  });
  const cancelDelegation = useAtomCommand(vmAgentEnvironment.cancelDelegation, {
    reportFailure: false,
  });

  useEffect(() => {
    if (!delegationId || !selected) return;
    const revision = selected.delegation.revision;
    const previousRevision = observedRevisions.current[delegationId];
    observedRevisions.current = { ...observedRevisions.current, [delegationId]: revision };
    if (previousRevision !== undefined && previousRevision !== revision) detailQuery.refresh();
  }, [delegationId, detailQuery.refresh, selected]);

  useEffect(() => {
    if (!delegationId || !detail || detail.delegation.delegationId !== delegationId) return;
    setMessageHistory((current) => {
      const existing = current[delegationId];
      const merged = mergeCollaborationMessages(existing?.messages ?? [], detail.messages);
      const hasEarlier = hasEarlierCollaborationMessages(
        detail.hasEarlierMessages,
        detail.delegation.messageCount,
        merged.length,
      );
      if (
        existing &&
        existing.hasEarlierMessages === hasEarlier &&
        sameMessageReferences(existing.messages, merged)
      ) {
        return current;
      }
      return { ...current, [delegationId]: { messages: merged, hasEarlierMessages: hasEarlier } };
    });
  }, [delegationId, detail]);

  useEffect(() => {
    const olderDetail = historyQuery.data;
    if (
      !delegationId ||
      historyBeforeSequence === null ||
      !olderDetail ||
      olderDetail.delegation.delegationId !== delegationId
    ) {
      return;
    }
    setMessageHistory((current) => {
      const existing = current[delegationId];
      const merged = mergeCollaborationMessages(
        existing?.messages ?? [],
        olderDetail.messages,
        detail?.delegation.delegationId === delegationId ? detail.messages : [],
      );
      const hasEarlier = hasEarlierAfterCollaborationPage({
        beforeSequence: historyBeforeSequence,
        page: olderDetail.messages,
        mergedMessageCount: merged.length,
        totalMessageCount: olderDetail.delegation.messageCount,
        serverValue: olderDetail.hasEarlierMessages,
      });
      if (
        existing &&
        existing.hasEarlierMessages === hasEarlier &&
        sameMessageReferences(existing.messages, merged)
      ) {
        return current;
      }
      return { ...current, [delegationId]: { messages: merged, hasEarlierMessages: hasEarlier } };
    });
    setHistoryBeforeSequences((current) => {
      if (current[delegationId] !== historyBeforeSequence) return current;
      const next = { ...current };
      delete next[delegationId];
      return next;
    });
  }, [delegationId, detail, historyBeforeSequence, historyQuery.data]);

  const send = async () => {
    const message = currentMessageDraft.trim();
    if (!selected || !message || pendingOperation !== null) return;
    const selectedDelegationId = selected.delegation.delegationId;
    setPendingOperation({ delegationId: selectedDelegationId, kind: "send" });
    setError(null);
    const sent = await sendMessage({
      environmentId: props.environmentId,
      input: {
        delegationId: selectedDelegationId,
        message,
        kind: delegationFollowupKind(selected.delegation.status),
        waitForReply: false,
      },
    });
    setPendingOperation((current) =>
      current?.delegationId === selectedDelegationId && current.kind === "send" ? null : current,
    );
    if (sent._tag === "Success") {
      setMessageDrafts((current) => ({ ...current, [selectedDelegationId]: "" }));
      detailQuery.refresh();
    } else {
      setError("The follow-up could not be sent.");
    }
  };

  const cancel = () => {
    if (!selected || pendingOperation !== null) return;
    const selectedDelegationId = selected.delegation.delegationId;
    Alert.alert("Cancel delegated work?", "The worker will be asked to stop this bounded task.", [
      { text: "Keep running", style: "cancel" },
      {
        text: "Cancel work",
        style: "destructive",
        onPress: () => {
          setPendingOperation({ delegationId: selectedDelegationId, kind: "cancel" });
          setError(null);
          void cancelDelegation({
            environmentId: props.environmentId,
            input: { delegationId: selectedDelegationId },
          }).then((cancelled) => {
            setPendingOperation((current) =>
              current?.delegationId === selectedDelegationId && current.kind === "cancel"
                ? null
                : current,
            );
            if (cancelled._tag === "Failure") setError("The delegation could not be cancelled.");
          });
        },
      },
    ]);
  };

  return (
    <View className="min-w-0 gap-3">
      <View className="min-w-0 flex-row flex-wrap items-center justify-between gap-2">
        <View className="min-w-0 flex-1">
          <Text className="text-lg font-t3-bold text-foreground">Collaboration</Text>
          <Text className="text-sm text-foreground-muted">
            The named root persists; each worker run is bounded.
          </Text>
        </View>
        <Pressable
          accessibilityLabel="Open root chat to delegate work"
          accessibilityRole="button"
          className="min-h-11 justify-center rounded-xl bg-primary px-4 active:opacity-80"
          disabled={props.agent.threadId === null}
          onPress={props.onOpenChat}
        >
          <Text className="text-sm font-t3-bold text-primary-foreground">Delegate in chat</Text>
        </Pressable>
      </View>
      {collaborationQuery.error ? (
        <View className="min-w-0 gap-2 rounded-2xl border border-red-500/25 bg-sheet p-3">
          <Text className="text-sm text-red-700 dark:text-red-300">
            Collaboration updates are unavailable. {collaborationQuery.error}
          </Text>
          <Pressable
            accessibilityLabel="Retry collaboration updates"
            accessibilityRole="button"
            className="min-h-11 self-start justify-center rounded-xl border border-border px-4"
            onPress={collaborationQuery.refresh}
          >
            <Text className="font-t3-bold text-foreground">Retry</Text>
          </Pressable>
        </View>
      ) : null}
      {snapshot ? (
        <View className="min-w-0 gap-2">
          <Text className="text-xs font-t3-bold uppercase text-foreground-muted">
            Available collaborators
          </Text>
          {collaborators.length === 0 && !hasMoreAgents ? (
            <View className="rounded-2xl border border-border bg-sheet p-4">
              <Text className="text-sm text-foreground-muted">
                No other named agents are online. The root can still create a bounded ephemeral
                sub-agent through chat.
              </Text>
            </View>
          ) : (
            collaborators.map((candidate) => (
              <View
                key={candidate.vmAgentId}
                className="min-w-0 gap-2 rounded-2xl border border-border bg-sheet p-3"
              >
                <View className="min-w-0 flex-row flex-wrap items-center gap-2">
                  <Text className="min-w-0 flex-1 font-t3-bold text-foreground" numberOfLines={1}>
                    {candidate.name}
                  </Text>
                  <StatusChip value={candidate.availability} />
                  {candidate.activeDelegations > 0 ? (
                    <StatusChip value={`${candidate.activeDelegations} active`} />
                  ) : null}
                </View>
                <Text className="text-sm text-foreground-muted" numberOfLines={2}>
                  {candidate.purpose}
                </Text>
                {candidate.capabilities.length > 0 ? (
                  <View className="min-w-0 flex-row flex-wrap gap-1">
                    {candidate.capabilities.map((capability) => (
                      <StatusChip key={capability} value={capability} />
                    ))}
                  </View>
                ) : null}
                {candidate.providerInstanceId || candidate.model ? (
                  <Text className="text-xs text-foreground-muted" numberOfLines={1}>
                    {[candidate.providerInstanceId, candidate.model].filter(Boolean).join(" · ")}
                  </Text>
                ) : null}
              </View>
            ))
          )}
          {hasMoreAgents ? (
            <View className="rounded-xl border border-border bg-screen/50 px-3 py-2">
              <Text className="text-xs text-foreground-muted">
                This host has additional agents outside the bounded live roster, so some targets are
                not shown here.
              </Text>
            </View>
          ) : null}
        </View>
      ) : null}
      {snapshot === null && collaborationQuery.error === null ? (
        <View className="rounded-2xl border border-border bg-sheet p-4">
          <Text className="text-sm text-foreground-muted">Loading delegated work…</Text>
        </View>
      ) : snapshot !== null && delegations.length === 0 ? (
        <View className="rounded-2xl border border-border bg-sheet p-4">
          <Text className="text-sm text-foreground-muted">
            {emptyDelegationListMessage(hasMoreDelegations)}
          </Text>
        </View>
      ) : delegations.length > 0 ? (
        <View className="min-w-0 gap-2">
          {delegations.map((entry) => (
            <Pressable
              key={entry.delegation.delegationId}
              accessibilityRole="button"
              accessibilityState={{
                selected: selected?.delegation.delegationId === entry.delegation.delegationId,
              }}
              className={`min-h-11 min-w-0 rounded-xl border px-3 py-2 ${
                selected?.delegation.delegationId === entry.delegation.delegationId
                  ? "border-primary bg-primary/5"
                  : "border-border bg-sheet"
              }`}
              onPress={() => {
                setSelectedId(entry.delegation.delegationId);
                setError(null);
              }}
            >
              <View className="min-w-0 flex-row flex-wrap items-center gap-2">
                <Text className="min-w-0 flex-1 font-t3-bold text-foreground" numberOfLines={1}>
                  {entry.delegation.title}
                </Text>
                <StatusChip value={entry.delegation.status} />
              </View>
              <Text className="mt-1 text-xs text-foreground-muted" numberOfLines={2}>
                {delegationDirectionLabel(entry, props.agent.vmAgentId)}
              </Text>
            </Pressable>
          ))}
          {hasMoreDelegations ? (
            <View className="rounded-xl border border-border bg-screen/50 px-3 py-2">
              <Text className="text-xs text-foreground-muted">
                Showing the most recent handoffs. Older history is outside this bounded live view.
              </Text>
            </View>
          ) : null}
        </View>
      ) : null}
      {selected ? (
        <View className="min-w-0 gap-3 rounded-2xl border border-border bg-sheet p-3">
          <View className="min-w-0 gap-1 rounded-xl border border-border bg-screen/50 p-3">
            <Text className="text-xs font-t3-bold uppercase text-foreground-muted">Brief</Text>
            <MobileBoundedCollaborationText
              key={`brief:${delegationId}`}
              text={briefText}
              maxCharacters={420}
              maxLines={5}
              collapsedLabel="Show full brief"
            />
          </View>
          {selected.delegation.status === "pending-approval" ? (
            <View className="min-w-0 gap-2 rounded-xl bg-amber-500/10 p-3">
              <Text className="text-xs font-t3-bold text-amber-700 dark:text-amber-300">
                Human approval required
              </Text>
              <Text className="text-sm text-foreground">
                Review and approve this request in the root agent chat. It will never be approved
                automatically.
              </Text>
              <Pressable
                accessibilityLabel="Open pending collaboration approval"
                accessibilityRole="button"
                className="min-h-11 items-center justify-center rounded-xl bg-primary px-4"
                onPress={props.onOpenChat}
              >
                <Text className="font-t3-bold text-primary-foreground">Open approval</Text>
              </Pressable>
            </View>
          ) : null}
          {selected.delegation.status === "waiting-input" ? (
            <View className="rounded-xl bg-amber-500/10 p-3">
              <Text className="text-xs font-t3-bold text-amber-700 dark:text-amber-300">
                Waiting for your answer
              </Text>
              <View className="mt-1">
                <MobileBoundedCollaborationText
                  key={`question:${waitingQuestion?.messageId ?? delegationId}`}
                  text={waitingQuestion?.text ?? "The worker needs input before it can continue."}
                  maxCharacters={600}
                  maxLines={6}
                  collapsedLabel="Show full question"
                />
              </View>
            </View>
          ) : null}
          {resultText !== null ? (
            <View className="rounded-xl bg-emerald-500/10 p-3">
              <Text className="text-xs font-t3-bold text-emerald-700 dark:text-emerald-300">
                Completed result
              </Text>
              <View className="mt-1">
                <MobileBoundedCollaborationText
                  key={`result:${delegationId}`}
                  text={resultText}
                  maxCharacters={700}
                  maxLines={7}
                  collapsedLabel="Show full result"
                />
              </View>
            </View>
          ) : null}
          {delegationError !== null ? (
            <View className="rounded-xl bg-red-500/10 p-3">
              <Text className="text-xs font-t3-bold text-red-700 dark:text-red-300">Error</Text>
              <View className="mt-1">
                <MobileBoundedCollaborationText
                  key={`error:${delegationId}`}
                  text={delegationError}
                  maxCharacters={500}
                  maxLines={6}
                  collapsedLabel="Show full error"
                  textClassName="text-sm text-red-700 dark:text-red-300"
                />
              </View>
            </View>
          ) : null}
          {detailQuery.error ? (
            <View className="min-w-0 gap-2 rounded-xl border border-red-500/25 p-3">
              <Text className="text-sm text-red-700 dark:text-red-300">
                The handoff details could not be loaded. {detailQuery.error}
              </Text>
              <Pressable
                accessibilityLabel="Retry handoff details"
                accessibilityRole="button"
                className="min-h-11 self-start justify-center rounded-xl border border-border px-4"
                onPress={detailQuery.refresh}
              >
                <Text className="font-t3-bold text-foreground">Retry</Text>
              </Pressable>
            </View>
          ) : null}
          {historyQuery.error ? (
            <View className="min-w-0 gap-2 rounded-xl border border-red-500/25 p-3">
              <Text className="text-sm text-red-700 dark:text-red-300">
                Earlier messages could not be loaded. {historyQuery.error}
              </Text>
              <Pressable
                accessibilityLabel="Retry earlier collaboration messages"
                accessibilityRole="button"
                className="min-h-11 self-start justify-center rounded-xl border border-border px-4"
                onPress={historyQuery.refresh}
              >
                <Text className="font-t3-bold text-foreground">Retry</Text>
              </Pressable>
            </View>
          ) : null}
          {hasEarlierMessages && oldestLoadedSequence !== null && historyQuery.error === null ? (
            <Pressable
              accessibilityLabel="Load earlier collaboration messages"
              accessibilityRole="button"
              accessibilityState={{ busy: isLoadingEarlier }}
              className="min-h-10 self-center justify-center rounded-xl px-3 active:bg-subtle"
              disabled={isLoadingEarlier}
              onPress={() => {
                if (!delegationId) return;
                setHistoryBeforeSequences((current) => ({
                  ...current,
                  [delegationId]: oldestLoadedSequence,
                }));
              }}
            >
              <Text className="text-xs font-t3-bold text-primary">
                {isLoadingEarlier ? "Loading earlier messages…" : "Show earlier messages"}
              </Text>
            </Pressable>
          ) : null}
          <View className="min-w-0 gap-2">
            {messages.map((item) => (
              <View
                key={item.messageId}
                className={`max-w-[92%] rounded-xl px-3 py-2 ${
                  item.sender === "target-agent"
                    ? "self-start bg-subtle"
                    : item.sender === "system"
                      ? "self-center border border-border"
                      : "self-end bg-primary/10"
                }`}
              >
                <MobileBoundedCollaborationText
                  text={item.text}
                  maxCharacters={800}
                  maxLines={8}
                  collapsedLabel="Show full message"
                />
                <Text className="mt-1 text-2xs text-foreground-muted">
                  {senderName(item, selected)} · {item.kind}
                  {item.delivery === "pending" ? " · sending" : ""}
                </Text>
              </View>
            ))}
            {detail === null && detailQuery.error === null ? (
              <Text className="text-sm text-foreground-muted">Loading conversation…</Text>
            ) : messages.length === 0 ? (
              <Text className="text-sm text-foreground-muted">No messages yet.</Text>
            ) : null}
          </View>
          {!TERMINAL_STATUSES.has(selected.delegation.status) ? (
            <>
              <TextInput
                accessibilityLabel="Delegation follow-up"
                className="max-h-32 min-h-20 rounded-xl border border-input-border bg-input px-3 py-2 text-base text-foreground"
                multiline
                maxLength={20_000}
                scrollEnabled
                textAlignVertical="top"
                placeholder={
                  selected.delegation.status === "waiting-input"
                    ? "Answer the worker’s question"
                    : "Send a bounded follow-up"
                }
                value={currentMessageDraft}
                onChangeText={(value) => {
                  if (!delegationId) return;
                  setMessageDrafts((current) => ({ ...current, [delegationId]: value }));
                }}
              />
              <View className="min-w-0 flex-row flex-wrap justify-end gap-2">
                <Pressable
                  accessibilityRole="button"
                  className="min-h-11 justify-center rounded-xl border border-border px-4"
                  disabled={pendingOperation !== null}
                  onPress={cancel}
                >
                  <Text className="font-t3-bold text-foreground">
                    {isCancelling ? "Cancelling…" : "Cancel work"}
                  </Text>
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  className="min-h-11 justify-center rounded-xl bg-primary px-4 disabled:opacity-50"
                  disabled={pendingOperation !== null || currentMessageDraft.trim().length === 0}
                  onPress={() => void send()}
                >
                  <Text className="font-t3-bold text-primary-foreground">
                    {isSending ? "Sending…" : "Send"}
                  </Text>
                </Pressable>
              </View>
            </>
          ) : null}
        </View>
      ) : null}
      {error ? <Text className="text-sm text-red-600 dark:text-red-300">{error}</Text> : null}
    </View>
  );
}

function notificationPreview(body: string): string {
  return body.replace(/\s+/g, " ").trim();
}

function AgentInboxSection(props: {
  readonly environmentId: EnvironmentId;
  readonly agent: VmAgent;
}) {
  const [folder, setFolder] = useState<"inbox" | "archive">("inbox");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const workspaceAtom = useMemo(
    () =>
      vmAgentEnvironment.workspace({
        environmentId: props.environmentId,
        input: { vmAgentId: props.agent.vmAgentId },
      }),
    [props.agent.vmAgentId, props.environmentId],
  );
  const result = useAtomValue(workspaceAtom);
  const item = Option.getOrNull(AsyncResult.value(result));
  const workspace = item?.type === "snapshot" ? item : null;
  const notifications = workspace?.notifications ?? [];
  const visible = notifications.filter((notification) =>
    folder === "inbox" ? notification.archivedAt === null : notification.archivedAt !== null,
  );
  const selected =
    visible.find((notification) => notification.notificationId === selectedId) ?? null;
  const updateNotification = useAtomCommand(vmAgentEnvironment.updateNotification, {
    reportFailure: false,
  });

  const mutate = async (
    notification: VmAgentNotification,
    patch: { readonly read?: boolean; readonly archived?: boolean },
  ) => {
    setPendingId(notification.notificationId);
    setError(null);
    const updated = await updateNotification({
      environmentId: props.environmentId,
      input: {
        vmAgentId: props.agent.vmAgentId,
        notificationId: notification.notificationId,
        ...patch,
      },
    });
    setPendingId(null);
    if (updated._tag === "Failure") {
      setError("The inbox item could not be updated.");
      return;
    }
    if (patch.archived !== undefined) setSelectedId(null);
  };

  const open = (notification: VmAgentNotification) => {
    setSelectedId(notification.notificationId);
    if (notification.readAt === null) void mutate(notification, { read: true });
  };

  const inboxCount = notifications.filter(
    (notification) => notification.archivedAt === null,
  ).length;
  const archiveCount = notifications.length - inboxCount;

  return (
    <View className="min-w-0 gap-3">
      <View className="min-w-0 gap-1">
        <Text className="text-lg font-t3-bold text-foreground">Inbox</Text>
        <Text className="text-sm text-foreground-muted">
          Read agent updates, mark them unread, or archive finished items.
        </Text>
      </View>
      <View className="min-w-0 flex-row gap-2">
        {(
          [
            ["inbox", "Inbox", inboxCount],
            ["archive", "Archive", archiveCount],
          ] as const
        ).map(([value, label, count]) => (
          <Pressable
            key={value}
            accessibilityRole="button"
            accessibilityState={{ selected: folder === value }}
            className={`min-h-11 flex-1 flex-row items-center justify-center gap-2 rounded-xl border px-3 ${
              folder === value ? "border-primary bg-primary/10" : "border-border bg-sheet"
            }`}
            onPress={() => {
              setFolder(value);
              setSelectedId(null);
            }}
          >
            <SymbolView
              name={value === "inbox" ? "tray" : "archivebox.fill"}
              size={16}
              tintColor={folder === value ? "#2563eb" : "#737373"}
            />
            <Text className="font-t3-bold text-foreground">
              {label} · {count}
            </Text>
          </Pressable>
        ))}
      </View>
      {result._tag === "Failure" ? (
        <View className="rounded-2xl border border-red-500/25 bg-sheet p-4">
          <Text className="text-sm text-red-700 dark:text-red-300">
            The inbox is unavailable while this host reconnects.
          </Text>
        </View>
      ) : visible.length === 0 ? (
        <View className="rounded-2xl border border-border bg-sheet p-4">
          <Text className="text-sm text-foreground-muted">
            {folder === "archive" ? "No archived messages." : "Your inbox is clear."}
          </Text>
        </View>
      ) : (
        <View className="min-w-0 gap-2">
          {visible.map((notification) => (
            <Pressable
              key={notification.notificationId}
              accessibilityRole="button"
              className={`min-h-16 min-w-0 gap-1 rounded-2xl border px-4 py-3 active:bg-subtle ${
                selected?.notificationId === notification.notificationId
                  ? "border-primary bg-primary/5"
                  : "border-border bg-sheet"
              }`}
              onPress={() => open(notification)}
            >
              <View className="min-w-0 flex-row items-center gap-2">
                {notification.readAt === null ? (
                  <View className="size-2 shrink-0 rounded-full bg-primary" />
                ) : null}
                <Text
                  className={`min-w-0 flex-1 text-base text-foreground ${
                    notification.readAt === null ? "font-t3-bold" : "font-t3-medium"
                  }`}
                  numberOfLines={1}
                >
                  {notification.title}
                </Text>
              </View>
              <Text className="text-sm text-foreground-muted" numberOfLines={2}>
                {notificationPreview(notification.body)}
              </Text>
            </Pressable>
          ))}
        </View>
      )}
      {selected ? (
        <View className="min-w-0 gap-4 rounded-2xl border border-border bg-sheet p-4">
          <View className="min-w-0 gap-1">
            <Text className="text-lg font-t3-bold text-foreground">{selected.title}</Text>
            <Text className="text-xs text-foreground-muted">
              {new Date(selected.createdAt).toLocaleString()}
            </Text>
          </View>
          <View className="min-w-0 rounded-xl border border-border bg-screen p-4">
            <MarkdownDocument markdown={selected.body} />
          </View>
          <View className="min-w-0 flex-row flex-wrap justify-end gap-2">
            <Pressable
              accessibilityRole="button"
              className="min-h-11 justify-center rounded-xl border border-border px-4 disabled:opacity-50"
              disabled={pendingId === selected.notificationId}
              onPress={() => void mutate(selected, { read: selected.readAt === null })}
            >
              <Text className="font-t3-bold text-foreground">
                {selected.readAt === null ? "Mark read" : "Mark unread"}
              </Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              className="min-h-11 justify-center rounded-xl bg-primary px-4 disabled:opacity-50"
              disabled={pendingId === selected.notificationId}
              onPress={() =>
                void mutate(selected, {
                  archived: folder !== "archive",
                  ...(folder === "archive" ? {} : { read: true }),
                })
              }
            >
              <Text className="font-t3-bold text-primary-foreground">
                {folder === "archive" ? "Restore" : "Archive"}
              </Text>
            </Pressable>
          </View>
        </View>
      ) : null}
      {error ? <Text className="text-sm text-red-600 dark:text-red-300">{error}</Text> : null}
    </View>
  );
}

type AgentRouteProps = StaticScreenProps<{
  readonly environmentId: string;
  readonly agentId: string;
}>;

export function AgentRouteScreen({ route }: AgentRouteProps) {
  const navigation = useNavigation();
  const environmentId = EnvironmentId.make(route.params.environmentId);
  const agentsAtom = useMemo(
    () => vmAgentEnvironment.agents({ environmentId, input: {} }),
    [environmentId],
  );
  const result = useAtomValue(agentsAtom);
  const latest = Option.getOrNull(AsyncResult.value(result));
  const agent =
    latest?.type === "snapshot"
      ? (latest.agents.find((candidate) => candidate.vmAgentId === route.params.agentId) ?? null)
      : null;

  if (result._tag === "Failure") {
    return (
      <View className="flex-1 items-center justify-center bg-screen px-6">
        <EmptyState title="Agent unavailable" detail="Reconnect to this host and try again." />
      </View>
    );
  }
  if (!agent) {
    return (
      <View className="flex-1 items-center justify-center bg-screen px-6">
        <Text className="text-sm text-foreground-muted">Loading agent…</Text>
      </View>
    );
  }

  return (
    <ScrollView
      className="flex-1 bg-screen"
      contentInsetAdjustmentBehavior="automatic"
      showsHorizontalScrollIndicator={false}
      contentContainerClassName="min-w-0 gap-5 px-4 py-5"
    >
      <View className="min-w-0 gap-3 rounded-2xl border border-border bg-sheet p-4">
        <View className="min-w-0 flex-row flex-wrap items-start gap-3">
          <View className="size-12 shrink-0 items-center justify-center rounded-full bg-primary/10">
            <Text className="text-xl font-t3-bold text-primary">
              {agent.name.slice(0, 1).toUpperCase()}
            </Text>
          </View>
          <View className="min-w-0 flex-1">
            <Text className="text-xl font-t3-bold text-foreground" numberOfLines={1}>
              {agent.name}
            </Text>
            <Text className="text-sm text-foreground-muted">@{agent.handle}</Text>
          </View>
          <StatusChip value={agent.status} />
        </View>
        <Text className="text-base leading-6 text-foreground">{agent.purpose}</Text>
        <View className="min-w-0 flex-row flex-wrap gap-2">
          <StatusChip value={`control: ${agent.controlMode}`} />
        </View>
        <Pressable
          accessibilityRole="button"
          className="min-h-11 items-center justify-center rounded-xl bg-primary px-4 disabled:opacity-50"
          disabled={agent.threadId === null}
          onPress={() => {
            if (!agent.threadId) return;
            navigation.navigate("Thread", {
              environmentId: String(environmentId),
              threadId: String(agent.threadId),
            });
          }}
        >
          <Text className="font-t3-bold text-primary-foreground">Open agent chat</Text>
        </Pressable>
      </View>
      <AgentInboxSection environmentId={environmentId} agent={agent} />
      <CollaborationSection
        environmentId={environmentId}
        agent={agent}
        onOpenChat={() => {
          if (!agent.threadId) return;
          navigation.navigate("Thread", {
            environmentId: String(environmentId),
            threadId: String(agent.threadId),
          });
        }}
      />
    </ScrollView>
  );
}
