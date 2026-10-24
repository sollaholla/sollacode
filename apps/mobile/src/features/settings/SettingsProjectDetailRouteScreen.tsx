import {
  dailyTokenSeries,
  folderUsageNotes,
  formatByteSize,
  formatTokenCount,
  formatUsdAmount,
  projectStorageBytes,
  providerUsageRows,
  storageSegments,
  tokenSegments,
  tokenTrackingNote,
  totalTokens,
  type ProjectOverview,
  type StorageSegmentKey,
  type TokenSegmentKey,
} from "@t3tools/client-runtime/state/project-statistics";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { OrchestrationProjectStatistics } from "@t3tools/contracts";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import * as Haptics from "expo-haptics";
import { useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AndroidScreenHeader } from "../../components/AndroidScreenHeader";
import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text, AppTextInput as TextInput } from "../../components/AppText";
import { showConfirmDialog } from "../../components/ConfirmDialogHost";
import { ProjectFavicon } from "../../components/ProjectFavicon";
import { cn } from "../../lib/cn";
import { relativeTime } from "../../lib/time";
import { useThemeColor } from "../../lib/useThemeColor";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { useServerConfigs, useThreadShells } from "../../state/entities";
import { projectEnvironment } from "../../state/projects";
import { useProjectOverviews } from "../../state/projectStatistics";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsSection } from "./components/SettingsSection";

type SettingsProjectDetailRouteProps = StaticScreenProps<{
  readonly environmentId: string;
  readonly projectId: string;
}>;

const GOLD = "bg-[#d9a93a]";

const STORAGE_SEGMENT_CLASS: Record<StorageSegmentKey, string> = {
  folder: "bg-[#a8781f]",
  history: GOLD,
  attachments: "bg-[#f5d77a]",
  artifacts: "bg-foreground-tertiary",
};

const TOKEN_SEGMENT_CLASS: Record<TokenSegmentKey, string> = {
  input: GOLD,
  cached: "bg-[#f5d77a]",
  cacheWrite: "bg-[#8c6718]",
  output: "bg-foreground-secondary",
};

const DAY_LABEL = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});

function plural(count: number, singular: string): string {
  return `${count.toLocaleString()} ${count === 1 ? singular : `${singular}s`}`;
}

function failureMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message.trim().length > 0 ? cause.message : fallback;
}

export function SettingsProjectDetailRouteScreen({ route }: SettingsProjectDetailRouteProps) {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const { overviews, environments, isLoading, tokenTrackingSince, refresh } = useProjectOverviews();
  const entry =
    overviews.find(
      (candidate) =>
        candidate.project.environmentId === route.params.environmentId &&
        candidate.project.id === route.params.projectId,
    ) ?? null;
  const generatedAt =
    environments.find((environment) => environment.environmentId === route.params.environmentId)
      ?.result?.generatedAt ?? null;
  const title = entry?.project.title ?? "Project";

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      {Platform.OS === "android" ? (
        <>
          <NativeStackScreenOptions options={{ headerShown: false }} />
          <AndroidScreenHeader title={title} onBack={() => navigation.goBack()} />
        </>
      ) : (
        <NativeStackScreenOptions options={{ title }} />
      )}
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
        refreshControl={
          entry === null ? undefined : (
            <RefreshControl
              refreshing={isLoading && entry.statistics !== null}
              // Loads the numbers again and measures this project's folder anew.
              onRefresh={() => refresh([entry.project.id])}
            />
          )
        }
      >
        {entry === null ? (
          <View className="rounded-[24px] bg-card px-6 py-8">
            <Text className="text-center text-base font-t3-medium text-foreground">
              This project isn't here anymore
            </Text>
            <Text className="mt-1 text-center text-sm leading-normal text-foreground-muted">
              It was removed, or its environment isn't connected right now.
            </Text>
          </View>
        ) : (
          <ProjectDetail
            entry={entry}
            generatedAt={generatedAt}
            isLoading={isLoading}
            trackingSince={tokenTrackingSince}
            onDeleted={() => navigation.goBack()}
          />
        )}
      </ScrollView>
    </View>
  );
}

function ProjectDetail(props: {
  readonly entry: ProjectOverview;
  readonly generatedAt: string | null;
  readonly isLoading: boolean;
  readonly trackingSince: string | null;
  readonly onDeleted: () => void;
}) {
  const { project, statistics, builtIn } = props.entry;
  const providers = useServerConfigs().get(project.environmentId)?.providers ?? [];

  return (
    <>
      <View className="flex-row items-center gap-3 px-1">
        <ProjectFavicon
          environmentId={project.environmentId}
          projectTitle={project.title}
          workspaceRoot={project.workspaceRoot}
          size={44}
        />
        <View className="min-w-0 flex-1">
          <Text className="text-xl font-t3-bold text-foreground" numberOfLines={1}>
            {project.title}
          </Text>
          <Text className="font-mono text-xs text-foreground-muted" numberOfLines={2}>
            {project.workspaceRoot}
          </Text>
        </View>
      </View>

      <View className="flex-row flex-wrap gap-2">
        <Tile
          label="Chats"
          value={statistics ? statistics.activeThreads.toLocaleString() : "—"}
          detail={
            statistics && statistics.archivedThreads > 0
              ? `+ ${statistics.archivedThreads.toLocaleString()} archived`
              : null
          }
        />
        <Tile label="Turns" value={statistics ? statistics.turns.toLocaleString() : "—"} />
        <Tile
          label="Storage"
          value={
            statistics === null && props.entry.folder?.bytes == null
              ? "—"
              : formatByteSize(projectStorageBytes(props.entry))
          }
          detail={props.entry.folder?.measuring ? "Measuring the folder…" : "folder and chats"}
        />
        <Tile
          label="Tokens · 30 days"
          value={statistics ? formatTokenCount(totalTokens(statistics.tokens.last30Days)) : "—"}
          detail={
            statistics && statistics.tokens.last30Days.costUsd > 0
              ? formatUsdAmount(statistics.tokens.last30Days.costUsd)
              : null
          }
        />
      </View>

      {statistics ? (
        <>
          <TokenUsage
            statistics={statistics}
            generatedAt={props.generatedAt}
            providers={providers}
            trackingSince={props.trackingSince}
          />
          <Storage statistics={statistics} folder={props.entry.folder} />
          <LargestChats statistics={statistics} />
        </>
      ) : (
        <Text className="px-2 text-sm text-foreground-muted">
          {props.isLoading ? "Loading this project's numbers…" : "No numbers for this project yet."}
        </Text>
      )}

      {builtIn ? (
        <Text className="px-2 text-sm leading-normal text-foreground-muted">
          Solla Code keeps the orchestrator's and agents' chats here, so this project can't be
          renamed or removed.
        </Text>
      ) : (
        <>
          <RenameProject entry={props.entry} />
          <DeleteProject entry={props.entry} onDeleted={props.onDeleted} />
        </>
      )}
    </>
  );
}

function Tile(props: {
  readonly label: string;
  readonly value: string;
  readonly detail?: string | null;
}) {
  return (
    <View className="min-w-[45%] flex-1 rounded-[18px] bg-card px-4 py-3">
      <Text className="text-2xs font-t3-bold tracking-[0.8px] text-foreground-muted uppercase">
        {props.label}
      </Text>
      <Text
        className="mt-1 text-xl font-t3-bold text-foreground"
        style={{ fontVariant: ["tabular-nums"] }}
      >
        {props.value}
      </Text>
      {props.detail ? <Text className="text-xs text-foreground-muted">{props.detail}</Text> : null}
    </View>
  );
}

function ShareBar(props: {
  readonly segments: ReadonlyArray<{ key: string; fraction: number; className: string }>;
}) {
  return (
    <View className="h-2 w-full flex-row overflow-hidden rounded-full bg-subtle-strong">
      {props.segments
        .filter((segment) => segment.fraction > 0)
        .map((segment) => (
          <View
            key={segment.key}
            className={cn("h-full", segment.className)}
            style={{ width: `${segment.fraction * 100}%` }}
          />
        ))}
    </View>
  );
}

function Legend(props: {
  readonly items: ReadonlyArray<{ key: string; label: string; value: string; className: string }>;
}) {
  return (
    <View className="flex-row flex-wrap gap-y-2">
      {props.items.map((item) => (
        <View key={item.key} className="w-1/2 gap-0.5">
          <View className="flex-row items-center gap-1.5">
            <View className={cn("size-2 rounded-full", item.className)} />
            <Text className="text-xs text-foreground-muted">{item.label}</Text>
          </View>
          <Text className="text-sm font-t3-medium text-foreground">{item.value}</Text>
        </View>
      ))}
    </View>
  );
}

function TokenUsage(props: {
  readonly statistics: OrchestrationProjectStatistics;
  readonly generatedAt: string | null;
  readonly providers: Parameters<typeof providerUsageRows>[1];
  readonly trackingSince: string | null;
}) {
  const { allTime, last30Days, daily, byProvider } = props.statistics.tokens;
  const series = useMemo(
    () => (props.generatedAt === null ? [] : dailyTokenSeries(daily, props.generatedAt)),
    [daily, props.generatedAt],
  );
  const providerRows = useMemo(
    () => providerUsageRows(byProvider, props.providers),
    [byProvider, props.providers],
  );
  const [selected, setSelected] = useState<number | null>(null);
  const peak = Math.max(0, ...series.map((entry) => entry.tokens));
  const focus = selected === null ? null : (series[selected] ?? null);
  const mix = tokenSegments(allTime);

  return (
    <SettingsSection title="Token usage" card>
      <View className="gap-5 p-4">
        <View className="flex-row items-end justify-between gap-4">
          <View>
            <Text className="text-xs text-foreground-muted">Last 30 days</Text>
            <Text className="text-2xl font-t3-bold text-foreground">
              {formatTokenCount(totalTokens(last30Days))}
            </Text>
            <Text className="text-xs text-foreground-muted">
              {plural(last30Days.turns, "turn")}
              {last30Days.costUsd > 0 ? ` · ${formatUsdAmount(last30Days.costUsd)}` : ""}
            </Text>
          </View>
          <View className="items-end">
            <Text className="text-xs text-foreground-muted">All time</Text>
            <Text className="text-sm font-t3-medium text-foreground">
              {formatTokenCount(totalTokens(allTime))}
              {allTime.costUsd > 0 ? ` · ${formatUsdAmount(allTime.costUsd)}` : ""}
            </Text>
          </View>
        </View>

        {series.length > 0 ? (
          <View className="gap-2">
            <View className="flex-row justify-between">
              <Text className="text-xs text-foreground-muted">
                {focus
                  ? DAY_LABEL.format(Date.parse(`${focus.day}T00:00:00.000Z`))
                  : "Tokens per day"}
              </Text>
              <Text className="text-xs text-foreground-muted">
                {focus
                  ? `${formatTokenCount(focus.tokens)} tokens`
                  : peak > 0
                    ? `Busiest day ${formatTokenCount(peak)}`
                    : "Nothing yet"}
              </Text>
            </View>
            <View
              className="h-24 flex-row items-end gap-[2px]"
              accessibilityRole="image"
              accessibilityLabel={`Tokens per day over the last ${series.length} days, busiest ${formatTokenCount(peak)}`}
            >
              {series.map((entry, index) => (
                <Pressable
                  key={entry.day}
                  className="h-full flex-1 justify-end"
                  onPress={() => setSelected((current) => (current === index ? null : index))}
                >
                  <View
                    className={cn(
                      "w-full rounded-[2px]",
                      entry.tokens === 0
                        ? "bg-subtle-strong"
                        : selected === index
                          ? "bg-[#f5d77a]"
                          : GOLD,
                    )}
                    style={{
                      height:
                        entry.tokens === 0
                          ? 2
                          : `${Math.max(4, (entry.tokens / Math.max(1, peak)) * 100)}%`,
                    }}
                  />
                </Pressable>
              ))}
            </View>
          </View>
        ) : null}

        {totalTokens(allTime) > 0 ? (
          <>
            <View className="gap-3">
              <ShareBar
                segments={mix.map((segment) => ({
                  key: segment.key,
                  fraction: segment.fraction,
                  className: TOKEN_SEGMENT_CLASS[segment.key],
                }))}
              />
              <Legend
                items={mix.map((segment) => ({
                  key: segment.key,
                  label: segment.label,
                  value: formatTokenCount(segment.value),
                  className: TOKEN_SEGMENT_CLASS[segment.key],
                }))}
              />
            </View>
            <View className="gap-3">
              <Text className="text-xs font-t3-medium text-foreground-muted">By provider</Text>
              {providerRows.map((row) => (
                <View key={row.key} className="gap-1.5">
                  <View className="flex-row items-baseline justify-between gap-3">
                    <Text className="shrink text-sm text-foreground" numberOfLines={1}>
                      {row.label}
                    </Text>
                    <Text className="text-sm text-foreground">
                      {formatTokenCount(row.tokens)}
                      {row.costUsd > 0 ? ` · ${formatUsdAmount(row.costUsd)}` : ""}
                    </Text>
                  </View>
                  <View className="h-1 w-full overflow-hidden rounded-full bg-subtle-strong">
                    <View
                      className={cn("h-full rounded-full", GOLD)}
                      style={{ width: `${row.fraction * 100}%` }}
                    />
                  </View>
                </View>
              ))}
            </View>
          </>
        ) : null}

        <Text className="text-xs leading-normal text-foreground-muted">
          {tokenTrackingNote(props.trackingSince)}
        </Text>
      </View>
    </SettingsSection>
  );
}

function Storage(props: {
  readonly statistics: OrchestrationProjectStatistics;
  readonly folder: ProjectOverview["folder"];
}) {
  const { folder } = props;
  const segments = storageSegments(props.statistics.storage, folder?.bytes ?? null);
  const worktrees = props.statistics.storage.worktrees;
  const notes = folderUsageNotes(folder);
  return (
    <SettingsSection title="Storage" card>
      <View className="gap-4 p-4">
        <View className="gap-0.5">
          <Text className="text-2xl font-t3-bold text-foreground">
            {formatByteSize(projectStorageBytes({ statistics: props.statistics, folder }))}
          </Text>
          <Text className="text-xs text-foreground-muted">
            {folder?.measuring
              ? "Measuring the folder…"
              : folder?.measuredAt
                ? `Folder measured ${relativeTime(folder.measuredAt)} ago`
                : "Folder and chats"}
          </Text>
        </View>
        <ShareBar
          segments={segments.map((segment) => ({
            key: segment.key,
            fraction: segment.fraction,
            className: STORAGE_SEGMENT_CLASS[segment.key],
          }))}
        />
        <Legend
          items={segments.map((segment) => ({
            key: segment.key,
            label: segment.label,
            value: formatByteSize(segment.value),
            className: STORAGE_SEGMENT_CLASS[segment.key],
          }))}
        />
        {notes.map((note) => (
          <Text key={note} className="text-xs leading-normal text-foreground-muted">
            {note}
          </Text>
        ))}
        {worktrees > 0 ? (
          <Text className="text-xs leading-normal text-foreground-muted">
            {plural(worktrees, "git worktree")} made for these chats{" "}
            {worktrees === 1 ? "lives" : "live"} outside the folder and{" "}
            {worktrees === 1 ? "isn't" : "aren't"} counted.
          </Text>
        ) : null}
      </View>
    </SettingsSection>
  );
}

function LargestChats(props: { readonly statistics: OrchestrationProjectStatistics }) {
  const total = props.statistics.activeThreads + props.statistics.archivedThreads;
  const shown = props.statistics.threads.slice(0, 10);
  if (shown.length === 0) return null;
  return (
    <SettingsSection title="Largest chats" card>
      {shown.map((thread, index) => (
        <View
          key={thread.threadId}
          className={cn(
            "flex-row items-center gap-3 px-4 py-3",
            index > 0 && "border-t border-separator",
          )}
        >
          <View className="min-w-0 flex-1">
            <Text className="text-sm text-foreground" numberOfLines={1}>
              {thread.title}
            </Text>
            <Text className="text-xs text-foreground-muted" numberOfLines={1}>
              {[
                thread.archived ? "Archived" : null,
                plural(thread.turns, "turn"),
                thread.tokens > 0 ? `${formatTokenCount(thread.tokens)} tokens` : null,
              ]
                .filter(Boolean)
                .join(" · ")}
            </Text>
          </View>
          <Text className="text-sm text-foreground">
            {formatByteSize(thread.historyBytes + thread.fileBytes)}
          </Text>
        </View>
      ))}
      {shown.length < total ? (
        <Text className="border-t border-separator px-4 py-2.5 text-xs text-foreground-muted">
          The {shown.length} largest of {total.toLocaleString()} chats.
        </Text>
      ) : null}
    </SettingsSection>
  );
}

function RenameProject(props: { readonly entry: ProjectOverview }) {
  const { project } = props.entry;
  const updateProject = useAtomCommand(projectEnvironment.update, { reportFailure: false });
  const [title, setTitle] = useState(project.title);
  const [saving, setSaving] = useState(false);
  // A rename from another device lands here too, unless one is being typed.
  useEffect(() => {
    if (!saving) setTitle(project.title);
  }, [project.title, saving]);
  const trimmed = title.trim();
  const changed = trimmed.length > 0 && trimmed !== project.title;

  const save = async () => {
    if (!changed || saving) return;
    setSaving(true);
    const result = await updateProject({
      environmentId: project.environmentId,
      input: { projectId: project.id, title: trimmed },
    });
    setSaving(false);
    if (result._tag === "Failure") {
      Alert.alert(
        "Couldn't rename the project",
        failureMessage(squashAtomCommandFailure(result), "The project could not be renamed."),
      );
      return;
    }
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  };

  return (
    <SettingsSection title="Name" card>
      <View className="flex-row items-center gap-2 p-3">
        <TextInput
          value={title}
          onChangeText={setTitle}
          onSubmitEditing={() => void save()}
          returnKeyType="done"
          accessibilityLabel="Project name"
          editable={!saving}
          className="min-h-[42px] min-w-0 flex-1 rounded-[14px] border border-input-border bg-input px-3 text-base text-foreground"
        />
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ disabled: !changed || saving }}
          disabled={!changed || saving}
          onPress={() => void save()}
          className={cn(
            "min-h-[42px] items-center justify-center rounded-[14px] bg-primary px-4 active:opacity-70",
            (!changed || saving) && "opacity-40",
          )}
        >
          <Text className="text-sm font-t3-medium text-primary-foreground">
            {saving ? "Saving…" : "Save"}
          </Text>
        </Pressable>
      </View>
    </SettingsSection>
  );
}

function DeleteProject(props: { readonly entry: ProjectOverview; readonly onDeleted: () => void }) {
  const { project, statistics } = props.entry;
  const deleteProject = useAtomCommand(projectEnvironment.delete, { reportFailure: false });
  const threadShells = useThreadShells();
  const dangerColor = useThemeColor("--color-danger-foreground");
  const [deleting, setDeleting] = useState(false);
  const chats = statistics
    ? statistics.activeThreads + statistics.archivedThreads
    : threadShells.filter(
        (thread) =>
          thread.environmentId === project.environmentId && thread.projectId === project.id,
      ).length;
  const working = threadShells.filter(
    (thread) =>
      thread.environmentId === project.environmentId &&
      thread.projectId === project.id &&
      thread.session?.status === "running",
  ).length;

  const remove = async () => {
    setDeleting(true);
    const result = await deleteProject({
      environmentId: project.environmentId,
      // Forced so chats created or unarchived since this screen loaded go too;
      // the confirmation already said every chat would.
      input: { projectId: project.id, force: true },
    });
    setDeleting(false);
    if (result._tag === "Failure") {
      Alert.alert(
        `Couldn't remove “${project.title}”`,
        failureMessage(squashAtomCommandFailure(result), "The project could not be removed."),
      );
      return;
    }
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    props.onDeleted();
  };

  const confirm = () => {
    const title = `Remove “${project.title}”?`;
    const message = [
      // First, because the path above a destructive button reads like the
      // thing being destroyed.
      `Nothing in ${project.workspaceRoot}${
        props.entry.folder?.bytes != null
          ? ` (${formatByteSize(props.entry.folder.bytes)} on disk)`
          : ""
      } is deleted. The folder and your files stay where they are.`,
      chats > 0
        ? `Its ${plural(chats, "chat")} will be deleted with their history, attachments, and artifacts.`
        : "It has no chats, so only the project entry goes.",
      working > 0
        ? `${plural(working, "chat")} ${working === 1 ? "is" : "are"} working right now and will be stopped.`
        : null,
      "This can't be undone.",
    ]
      .filter(Boolean)
      .join("\n\n");
    if (process.env.EXPO_OS === "ios") {
      Alert.alert(title, message, [
        { text: "Cancel", style: "cancel" },
        { text: "Remove Project", style: "destructive", onPress: () => void remove() },
      ]);
      return;
    }
    showConfirmDialog({
      title,
      message,
      confirmText: "Remove project",
      destructive: true,
      onConfirm: () => void remove(),
    });
  };

  return (
    <SettingsSection title="Remove" card>
      <Pressable
        accessibilityRole="button"
        disabled={deleting}
        onPress={confirm}
        className="flex-row items-center gap-3 p-4 active:opacity-70"
      >
        {deleting ? (
          <ActivityIndicator color={dangerColor} size="small" />
        ) : (
          <SymbolView name="trash" size={18} tintColor={dangerColor} type="monochrome" />
        )}
        <View className="min-w-0 flex-1">
          <Text className="text-base text-danger-foreground">
            {deleting ? "Removing…" : "Remove project"}
          </Text>
          <Text className="text-xs text-foreground-muted">
            Deletes its chats and their history. Nothing in its folder is deleted.
          </Text>
        </View>
      </Pressable>
    </SettingsSection>
  );
}
