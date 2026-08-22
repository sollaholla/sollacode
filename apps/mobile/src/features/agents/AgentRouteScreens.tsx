import { useAtomValue } from "@effect/atom-react";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import {
  EnvironmentId,
  type VmAgent,
  type VmAgentCollaborationSnapshot,
  type VmAgentDelegationMessage,
  type VmAgentDelegationStatus,
  type VmAgentDelegationSummary,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/unstable/reactivity";
import { useMemo, useState } from "react";
import { Alert, Pressable, ScrollView, View } from "react-native";

import { AppText as Text, AppTextInput as TextInput } from "../../components/AppText";
import { EmptyState } from "../../components/EmptyState";
import { useEnvironments } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { vmAgentEnvironment } from "../../state/vmAgents";
import { delegationFollowupKind, isDelegationRelatedToAgent } from "./agentCollaboration";

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
  const latest = Option.getOrNull(AsyncResult.value(result));
  const agents = latest?.type === "snapshot" ? latest.agents : [];
  const collaborationItem = Option.getOrNull(AsyncResult.value(collaborationResult));
  const collaboration = collaborationItem?.type === "snapshot" ? collaborationItem : null;

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

function CollaborationSection(props: {
  readonly environmentId: EnvironmentId;
  readonly agent: VmAgent;
  readonly onOpenChat: () => void;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const collaborationAtom = useMemo(
    () => vmAgentEnvironment.collaboration({ environmentId: props.environmentId, input: {} }),
    [props.environmentId],
  );
  const result = useAtomValue(collaborationAtom);
  const item = Option.getOrNull(AsyncResult.value(result));
  const snapshot = item?.type === "snapshot" ? item : null;
  const delegations = relatedDelegations(snapshot, props.agent.vmAgentId);
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
  const detail = useEnvironmentQuery(detailAtom).data;
  const sendMessage = useAtomCommand(vmAgentEnvironment.sendDelegationMessage, {
    reportFailure: false,
  });
  const cancelDelegation = useAtomCommand(vmAgentEnvironment.cancelDelegation, {
    reportFailure: false,
  });

  const send = async () => {
    if (!selected || !message.trim() || pending) return;
    setPending(true);
    setError(null);
    const sent = await sendMessage({
      environmentId: props.environmentId,
      input: {
        delegationId: selected.delegation.delegationId,
        message: message.trim(),
        kind: delegationFollowupKind(selected.delegation.status),
        waitForReply: false,
      },
    });
    setPending(false);
    if (sent._tag === "Success") setMessage("");
    else setError("The follow-up could not be sent.");
  };

  const cancel = () => {
    if (!selected || pending) return;
    Alert.alert("Cancel delegated work?", "The worker will be asked to stop this bounded task.", [
      { text: "Keep running", style: "cancel" },
      {
        text: "Cancel work",
        style: "destructive",
        onPress: () => {
          setPending(true);
          void cancelDelegation({
            environmentId: props.environmentId,
            input: { delegationId: selected.delegation.delegationId },
          }).then((cancelled) => {
            setPending(false);
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
      {snapshot ? (
        <View className="min-w-0 gap-2">
          <Text className="text-xs font-t3-bold uppercase text-foreground-muted">
            Available collaborators
          </Text>
          {snapshot.agents.filter((candidate) => candidate.vmAgentId !== props.agent.vmAgentId)
            .length === 0 ? (
            <View className="rounded-2xl border border-border bg-sheet p-4">
              <Text className="text-sm text-foreground-muted">
                No other named agents are online. The root can still create a bounded ephemeral
                sub-agent through chat.
              </Text>
            </View>
          ) : (
            snapshot.agents
              .filter((candidate) => candidate.vmAgentId !== props.agent.vmAgentId)
              .map((candidate) => (
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
        </View>
      ) : null}
      {delegations.length === 0 ? (
        <View className="rounded-2xl border border-border bg-sheet p-4">
          <Text className="text-sm text-foreground-muted">
            No delegated work yet. The root can create a named or ephemeral collaborator through
            chat.
          </Text>
        </View>
      ) : (
        <View className="min-w-0 gap-2">
          {delegations.map((entry) => (
            <Pressable
              key={entry.delegation.delegationId}
              accessibilityRole="button"
              className={`min-h-11 min-w-0 rounded-xl border px-3 py-2 ${
                selected?.delegation.delegationId === entry.delegation.delegationId
                  ? "border-primary bg-primary/5"
                  : "border-border bg-sheet"
              }`}
              onPress={() => setSelectedId(entry.delegation.delegationId)}
            >
              <View className="min-w-0 flex-row flex-wrap items-center gap-2">
                <Text className="min-w-0 flex-1 font-t3-bold text-foreground" numberOfLines={1}>
                  {entry.delegation.title}
                </Text>
                <StatusChip value={entry.delegation.status} />
              </View>
              <Text className="mt-1 text-xs text-foreground-muted" numberOfLines={2}>
                {entry.delegation.target.kind === "ephemeral"
                  ? "Ephemeral worker"
                  : (entry.targetAgent?.name ?? entry.delegation.targetAgentSnapshot?.name)}
              </Text>
            </Pressable>
          ))}
        </View>
      )}
      {selected ? (
        <View className="min-w-0 gap-3 rounded-2xl border border-border bg-sheet p-3">
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
              <Text className="mt-1 text-sm text-foreground">
                {[...(detail?.messages ?? [])].toReversed().find((item) => item.kind === "question")
                  ?.text ?? "The worker needs input before it can continue."}
              </Text>
            </View>
          ) : null}
          {selected.delegation.result ? (
            <View className="rounded-xl bg-emerald-500/10 p-3">
              <Text className="text-xs font-t3-bold text-emerald-700 dark:text-emerald-300">
                Completed result
              </Text>
              <Text className="mt-1 text-sm text-foreground">
                {selected.delegation.result.summary}
              </Text>
            </View>
          ) : null}
          <View className="min-w-0 gap-2">
            {(detail?.messages ?? []).map((item) => (
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
                <Text className="text-sm text-foreground">{item.text}</Text>
                <Text className="mt-1 text-2xs text-foreground-muted">
                  {senderName(item, selected)} · {item.kind}
                  {item.delivery === "pending" ? " · sending" : ""}
                </Text>
              </View>
            ))}
          </View>
          {!TERMINAL_STATUSES.has(selected.delegation.status) ? (
            <>
              <TextInput
                accessibilityLabel="Delegation follow-up"
                className="min-h-20 rounded-xl border border-input-border bg-input px-3 py-2 text-base text-foreground"
                multiline
                maxLength={20_000}
                placeholder={
                  selected.delegation.status === "waiting-input"
                    ? "Answer the worker’s question"
                    : "Send a bounded follow-up"
                }
                value={message}
                onChangeText={setMessage}
              />
              <View className="min-w-0 flex-row flex-wrap justify-end gap-2">
                <Pressable
                  accessibilityRole="button"
                  className="min-h-11 justify-center rounded-xl border border-border px-4"
                  disabled={pending}
                  onPress={cancel}
                >
                  <Text className="font-t3-bold text-foreground">Cancel work</Text>
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  className="min-h-11 justify-center rounded-xl bg-primary px-4 disabled:opacity-50"
                  disabled={pending || message.trim().length === 0}
                  onPress={() => void send()}
                >
                  <Text className="font-t3-bold text-primary-foreground">
                    {pending ? "Sending…" : "Send"}
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
