import {
  databaseCompactionConfirmMessage,
  describeDatabaseStorage,
} from "@t3tools/client-runtime/state/databaseStorage";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { DatabaseStorageStatus, EnvironmentId } from "@t3tools/contracts";
import { useEffect, useState } from "react";
import { ActivityIndicator, Alert, Pressable, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";

/**
 * One connected environment's database in Settings → Storage: its size, the
 * free space compaction would return, and scheduling or cancelling a
 * compaction for that computer's next start. A phone cannot restart the
 * computer's app, so there is no "Restart now" here. See docs/user/storage.md.
 */
export function DatabaseStorageRow(props: {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly first: boolean;
}) {
  const query = useEnvironmentQuery(
    serverEnvironment.databaseStorage({ environmentId: props.environmentId, input: {} }),
  );
  const scheduleCompaction = useAtomCommand(serverEnvironment.scheduleDatabaseCompaction, {
    reportFailure: false,
  });
  const cancelCompaction = useAtomCommand(serverEnvironment.cancelDatabaseCompaction, {
    reportFailure: false,
  });
  // A command's reply is shown until the query catches up, so the row never
  // flips back to its old state in between.
  const [replied, setReplied] = useState<DatabaseStorageStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const queried = query.data;
  useEffect(() => setReplied(null), [queried]);

  const status = replied ?? queried;
  const view = status === null ? null : describeDatabaseStorage(status);

  const run = async (command: typeof scheduleCompaction, failureTitle: string) => {
    setBusy(true);
    const result = await command({ environmentId: props.environmentId, input: {} });
    setBusy(false);
    if (result._tag === "Success") {
      setReplied(result.value);
      query.refresh();
      return;
    }
    if (isAtomCommandInterrupted(result)) return;
    const error = squashAtomCommandFailure(result);
    Alert.alert(failureTitle, error instanceof Error ? error.message : "Try again.");
  };

  const confirmSchedule = () => {
    if (status === null) return;
    Alert.alert(
      `Compact the database on ${props.label}?`,
      databaseCompactionConfirmMessage(status),
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Compact at next start",
          onPress: () => void run(scheduleCompaction, "Could not schedule compaction"),
        },
      ],
    );
  };

  const scheduled = status?.scheduled ?? null;
  return (
    <View className={props.first ? "gap-2 p-4" : "gap-2 border-t border-border p-4"}>
      <View className="flex-row items-center gap-3">
        <Text className="min-w-0 flex-1 text-base text-foreground" numberOfLines={1}>
          {props.label}
        </Text>
        {view === null ? (
          query.error === null ? (
            <ActivityIndicator />
          ) : null
        ) : (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={
              scheduled === null
                ? `Compact the database on ${props.label}`
                : `Cancel the scheduled compaction on ${props.label}`
            }
            disabled={busy || (scheduled === null && !view.reclaimable)}
            onPress={() =>
              scheduled === null
                ? confirmSchedule()
                : void run(cancelCompaction, "Could not cancel the scheduled compaction")
            }
            className="rounded-full px-3 py-2 disabled:opacity-40"
          >
            <Text className="font-t3-medium text-primary" numberOfLines={1}>
              {scheduled === null ? "Compact" : "Cancel"}
            </Text>
          </Pressable>
        )}
      </View>
      {view === null ? (
        <Text className="text-sm text-foreground-muted">
          {query.error === null
            ? "Reading the database size…"
            : `Could not read it: ${query.error}`}
        </Text>
      ) : (
        <>
          <Text className="text-sm text-foreground-muted">{view.summary}</Text>
          <Text className="text-sm text-foreground-muted">
            {scheduled === null ? view.requirement : view.scheduledNote}
          </Text>
          {view.diskWarning === null ? null : (
            <Text className="text-sm text-amber-700 dark:text-amber-300">{view.diskWarning}</Text>
          )}
          {view.lastResult === null ? null : (
            <Text
              className={
                view.lastResult.tone === "error"
                  ? "text-sm text-danger-foreground"
                  : view.lastResult.tone === "warning"
                    ? "text-sm text-amber-700 dark:text-amber-300"
                    : "text-sm text-foreground-muted"
              }
            >
              {`Last: ${view.lastResult.title} (${new Date(view.lastResult.finishedAt).toLocaleString()})${
                view.lastResult.detail.length === 0 ? "" : `. ${view.lastResult.detail}`
              }`}
            </Text>
          )}
        </>
      )}
    </View>
  );
}
