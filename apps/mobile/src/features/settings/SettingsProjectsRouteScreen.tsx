import {
  filterProjectOverviews,
  formatByteSize,
  formatTokenCount,
  formatUsdAmount,
  PROJECT_SORT_OPTIONS,
  sortProjectOverviews,
  summarizeProjectOverviews,
  tokenTrackingNote,
  projectStorageBytes,
  totalTokens,
  type ProjectOverview,
  type ProjectSortKey,
} from "@t3tools/client-runtime/state/project-statistics";
import { useNavigation } from "@react-navigation/native";
import { useMemo, useState } from "react";
import { Platform, Pressable, RefreshControl, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AndroidScreenHeader } from "../../components/AndroidScreenHeader";
import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text, AppTextInput as TextInput } from "../../components/AppText";
import { ProjectFavicon } from "../../components/ProjectFavicon";
import { cn } from "../../lib/cn";
import { useThemeColor } from "../../lib/useThemeColor";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { useProjectOverviews } from "../../state/projectStatistics";
import { useSavedRemoteConnections } from "../../state/use-remote-environment-registry";
import { SettingsSection } from "./components/SettingsSection";

/**
 * Settings → Projects on the phone: every project across connected
 * environments, with what it keeps on disk and the tokens its chats used.
 * Rename and remove live on each project's own screen.
 */
export function SettingsProjectsRouteScreen() {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const { overviews, isLoading, error, tokenTrackingSince, refresh } = useProjectOverviews();
  const { savedConnectionsById } = useSavedRemoteConnections();
  const [query, setQuery] = useState("");
  const [sortKey, setSortKey] = useState<ProjectSortKey>("recent");
  const mutedColor = useThemeColor("--color-icon-subtle");

  const visible = useMemo(
    () => sortProjectOverviews(filterProjectOverviews(overviews, query), sortKey),
    [overviews, query, sortKey],
  );
  const summary = useMemo(() => summarizeProjectOverviews(overviews), [overviews]);
  const hasStatistics = overviews.some((entry) => entry.statistics !== null);
  const multipleEnvironments =
    new Set(overviews.map((entry) => entry.project.environmentId)).size > 1;

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      {Platform.OS === "android" ? (
        <>
          <NativeStackScreenOptions options={{ headerShown: false }} />
          <AndroidScreenHeader title="Projects" onBack={() => navigation.goBack()} />
        </>
      ) : null}
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
        refreshControl={
          <RefreshControl refreshing={isLoading && hasStatistics} onRefresh={() => refresh()} />
        }
      >
        <Text className="px-2 text-sm leading-normal text-foreground-muted">
          Rename or remove projects, and see what each one keeps on disk and how many tokens its
          chats have used. Removing a project deletes its chats; nothing in its folder is deleted.
        </Text>

        <View className="flex-row flex-wrap gap-2">
          <SummaryTile label="Projects" value={summary.projects.toLocaleString()} />
          <SummaryTile
            label="Storage"
            value={hasStatistics ? formatByteSize(summary.storageBytes) : "—"}
          />
          <SummaryTile
            label="Tokens · 30 days"
            value={hasStatistics ? formatTokenCount(summary.tokensLast30Days) : "—"}
          />
          <SummaryTile
            label="Cost · 30 days"
            value={hasStatistics ? formatUsdAmount(summary.costLast30DaysUsd) : "—"}
          />
        </View>

        {error && !hasStatistics ? (
          <Pressable
            accessibilityRole="button"
            onPress={() => refresh()}
            className="rounded-[18px] bg-card px-4 py-3 active:opacity-70"
          >
            <Text className="text-sm leading-normal text-foreground-muted">
              {error} Tap to try again.
            </Text>
          </Pressable>
        ) : null}

        <View className="gap-3">
          <View className="min-h-[42px] flex-row items-center gap-2 rounded-[14px] border border-input-border bg-input px-3">
            <SymbolView name="magnifyingglass" size={14} tintColor={mutedColor} type="monochrome" />
            <TextInput
              value={query}
              onChangeText={setQuery}
              placeholder="Filter by name or folder"
              accessibilityLabel="Filter projects"
              autoCapitalize="none"
              autoCorrect={false}
              clearButtonMode="while-editing"
              className="min-w-0 flex-1 py-2.5 text-base text-foreground"
            />
          </View>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerClassName="gap-2"
          >
            {PROJECT_SORT_OPTIONS.map((option) => {
              const selected = option.key === sortKey;
              return (
                <Pressable
                  key={option.key}
                  accessibilityRole="button"
                  accessibilityState={{ selected }}
                  onPress={() => setSortKey(option.key)}
                  className={cn(
                    "rounded-full border px-3.5 py-1.5 active:opacity-70",
                    selected ? "border-foreground bg-foreground" : "border-border bg-card",
                  )}
                >
                  <Text
                    className={cn(
                      "text-sm",
                      selected ? "font-t3-medium text-card" : "text-foreground-secondary",
                    )}
                  >
                    {option.label}
                  </Text>
                </Pressable>
              );
            })}
          </ScrollView>
        </View>

        <SettingsSection title={query.trim() ? "Matching projects" : "All projects"} card>
          {overviews.length === 0 ? (
            <Text className="p-4 text-sm leading-normal text-foreground-muted">
              No projects yet. Add one and it will show up here with its storage and token usage.
            </Text>
          ) : visible.length === 0 ? (
            <Text className="p-4 text-sm leading-normal text-foreground-muted">
              No projects match “{query.trim()}”.
            </Text>
          ) : (
            visible.map((entry, index) => (
              <ProjectRow
                key={`${entry.project.environmentId}:${entry.project.id}`}
                entry={entry}
                first={index === 0}
                environmentLabel={
                  multipleEnvironments
                    ? (savedConnectionsById[entry.project.environmentId]?.environmentLabel ?? null)
                    : null
                }
                onPress={() =>
                  navigation.navigate("SettingsSheet", {
                    screen: "SettingsProjectDetail",
                    params: {
                      environmentId: entry.project.environmentId,
                      projectId: entry.project.id,
                    },
                  })
                }
              />
            ))
          )}
        </SettingsSection>

        <Text className="px-2 text-xs leading-normal text-foreground-muted">
          {tokenTrackingNote(tokenTrackingSince)}
        </Text>
      </ScrollView>
    </View>
  );
}

function SummaryTile(props: { readonly label: string; readonly value: string }) {
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
    </View>
  );
}

function ProjectRow(props: {
  readonly entry: ProjectOverview;
  readonly first: boolean;
  readonly environmentLabel: string | null;
  readonly onPress: () => void;
}) {
  const chevron = useThemeColor("--color-chevron");
  const { project, statistics, folder, builtIn } = props.entry;
  const chats = statistics ? statistics.activeThreads + statistics.archivedThreads : null;
  const detail =
    statistics === null || chats === null
      ? "—"
      : [
          `${chats.toLocaleString()} ${chats === 1 ? "chat" : "chats"}`,
          folder?.measuring && folder.bytes === null
            ? "measuring…"
            : formatByteSize(projectStorageBytes(props.entry)),
          `${formatTokenCount(totalTokens(statistics.tokens.last30Days))} tokens`,
        ].join(" · ");

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${project.title}, ${detail}`}
      onPress={props.onPress}
      className={cn(
        "flex-row items-center gap-3 px-4 py-3 active:opacity-70",
        !props.first && "border-t border-separator",
      )}
    >
      <ProjectFavicon
        environmentId={project.environmentId}
        projectTitle={project.title}
        workspaceRoot={project.workspaceRoot}
        size={34}
      />
      <View className="min-w-0 flex-1 gap-0.5">
        <View className="flex-row items-center gap-2">
          <Text className="shrink text-base font-t3-medium text-foreground" numberOfLines={1}>
            {project.title}
          </Text>
          {builtIn ? (
            <Text className="rounded-md bg-subtle px-1.5 py-0.5 text-2xs text-foreground-muted">
              Built-in
            </Text>
          ) : null}
        </View>
        <Text className="text-xs text-foreground-muted" numberOfLines={1}>
          {props.environmentLabel ? `${props.environmentLabel} · ${detail}` : detail}
        </Text>
      </View>
      <SymbolView
        name="chevron.right"
        size={14}
        tintColor={chevron}
        type="monochrome"
        weight="semibold"
      />
    </Pressable>
  );
}
