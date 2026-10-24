import {
  databaseCompactionConfirmMessage,
  describeDatabaseStorage,
  formatCompactionEstimate,
} from "@t3tools/client-runtime/state/databaseStorage";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { DatabaseStorageStatus } from "@t3tools/contracts";
import { useEffect, useState } from "react";

import { cn } from "../../lib/utils";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { useServerConfigs } from "../../state/entities";
import { usePrimaryEnvironment } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { confirmInApp } from "../ui/appConfirm";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { SettingsRow, SettingsSection } from "./settingsLayout";

const describeFailure = (result: Parameters<typeof squashAtomCommandFailure>[0]) => {
  const error = squashAtomCommandFailure(result);
  return error instanceof Error && error.message.trim().length > 0
    ? error.message
    : "The request did not reach the environment.";
};

/**
 * Settings → General → Storage: how big the primary environment's database is,
 * how much of it is free pages, and compaction at the next start (schedule,
 * cancel, restart now on desktop, and the last result). See
 * docs/user/storage.md.
 */
export function DatabaseStorageSettingsSection() {
  const primaryEnvironment = usePrimaryEnvironment();
  const environmentId = primaryEnvironment?.environmentId ?? null;
  const serverConfigs = useServerConfigs();
  const supported =
    environmentId !== null &&
    serverConfigs.get(environmentId)?.environment.capabilities.databaseCompaction === true;
  const query = useEnvironmentQuery(
    supported && environmentId !== null
      ? serverEnvironment.databaseStorage({ environmentId, input: {} })
      : null,
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
  const [busy, setBusy] = useState<"schedule" | "cancel" | "restart" | null>(null);
  const queried = query.data;
  useEffect(() => setReplied(null), [queried]);

  if (!supported || environmentId === null) return null;
  const status = replied ?? queried;
  const view = status === null ? null : describeDatabaseStorage(status);
  const relaunch =
    typeof window === "undefined" ? undefined : window.desktopBridge?.relaunchForDatabaseCompaction;

  const run = async (
    kind: "schedule" | "cancel",
    command: typeof scheduleCompaction,
    failureTitle: string,
  ) => {
    setBusy(kind);
    const result = await command({ environmentId, input: {} });
    setBusy(null);
    if (result._tag === "Success") {
      setReplied(result.value);
      query.refresh();
      return;
    }
    if (!isAtomCommandInterrupted(result)) {
      toastManager.add({
        type: "error",
        title: failureTitle,
        description: describeFailure(result),
      });
    }
  };

  const schedule = async () => {
    if (status === null || busy !== null) return;
    const confirmed = await confirmInApp(databaseCompactionConfirmMessage(status), {
      confirmLabel: "Compact at next start",
    });
    if (confirmed) await run("schedule", scheduleCompaction, "Could not schedule compaction");
  };

  const restartNow = async () => {
    if (status === null || busy !== null || relaunch === undefined) return;
    const confirmed = await confirmInApp(
      `Restart Solla Code now? Running agents stop and resume after the restart. The database is compacted first, which takes ${formatCompactionEstimate(status.estimatedSeconds)}.`,
      { confirmLabel: "Restart now" },
    );
    if (!confirmed) return;
    setBusy("restart");
    try {
      await relaunch();
    } catch (cause) {
      setBusy(null);
      toastManager.add({
        type: "error",
        title: "Could not restart Solla Code",
        description: cause instanceof Error ? cause.message : String(cause),
      });
    }
  };

  const scheduled = status?.scheduled ?? null;
  const control =
    view === null ? null : scheduled === null ? (
      <Button
        size="xs"
        variant="outline"
        disabled={busy !== null || !view.reclaimable}
        onClick={() => void schedule()}
      >
        {busy === "schedule" ? "Scheduling…" : "Compact database…"}
      </Button>
    ) : (
      <>
        {relaunch === undefined ? null : (
          <Button size="xs" disabled={busy !== null} onClick={() => void restartNow()}>
            {busy === "restart" ? "Restarting…" : "Restart now"}
          </Button>
        )}
        <Button
          size="xs"
          variant="outline"
          disabled={busy !== null}
          onClick={() =>
            void run("cancel", cancelCompaction, "Could not cancel the scheduled compaction")
          }
        >
          {busy === "cancel" ? "Cancelling…" : "Cancel"}
        </Button>
      </>
    );

  return (
    <SettingsSection title="Storage">
      <SettingsRow
        id="setting-database-compaction"
        title="Database"
        description={
          view?.summary ??
          (query.error === null
            ? "Reading the database size…"
            : `Could not read it: ${query.error}`)
        }
        status={
          view === null ? null : (
            <div className="space-y-0.5">
              <p>{scheduled === null ? view.requirement : view.scheduledNote}</p>
              {view.diskWarning === null ? null : (
                <p className="text-warning">{view.diskWarning}</p>
              )}
            </div>
          )
        }
        control={control}
      />
      {view?.lastResult ? (
        <SettingsRow
          title="Last compaction"
          description={`${view.lastResult.title} · ${formatRelativeTimeLabel(view.lastResult.finishedAt)}`}
          status={
            view.lastResult.detail.length === 0 ? null : (
              <span
                className={cn(
                  view.lastResult.tone === "error" && "text-destructive",
                  view.lastResult.tone === "warning" && "text-warning",
                )}
              >
                {view.lastResult.detail}
              </span>
            )
          }
        />
      ) : null}
    </SettingsSection>
  );
}
