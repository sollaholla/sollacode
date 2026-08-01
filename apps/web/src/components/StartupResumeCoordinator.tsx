import { useEffect, useMemo, useRef, useState } from "react";

import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";

import {
  useClientSettings,
  useClientSettingsHydrated,
  useUpdateClientSettings,
} from "../hooks/useSettings";
import { newMessageId } from "../lib/utils";
import {
  useAllEnvironmentShellsBootstrapped,
  useProjects,
  useThreadShells,
} from "../state/entities";
import { useEnvironments } from "../state/environments";
import { threadEnvironment } from "../state/threads";
import { useAtomCommand } from "../state/use-atom-command";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";
import { stackedThreadToast, toastManager } from "./ui/toast";
import {
  deriveStartupResumableThreads,
  pruneStartupResumeSelection,
  shouldAutoCloseStartupResume,
} from "./StartupResumeCoordinator.logic";

const STARTUP_RESUME_PROMPT_SESSION_KEY = "t3code:startup-resume-prompt:v1";

function threadKey(environmentId: string, threadId: string): string {
  return `${environmentId}:${threadId}`;
}

function wasPromptHandledThisStartup(): boolean {
  try {
    return window.sessionStorage.getItem(STARTUP_RESUME_PROMPT_SESSION_KEY) === "handled";
  } catch {
    return false;
  }
}

function markPromptHandledThisStartup(): void {
  try {
    window.sessionStorage.setItem(STARTUP_RESUME_PROMPT_SESSION_KEY, "handled");
  } catch {
    // A blocked sessionStorage must not prevent the prompt from working.
  }
}

export function StartupResumeCoordinator() {
  const settingsHydrated = useClientSettingsHydrated();
  const showOnStartup = useClientSettings((settings) => settings.showResumeThreadsOnStartup);
  const updateClientSettings = useUpdateClientSettings();
  const shellsBootstrapped = useAllEnvironmentShellsBootstrapped();
  const threads = useThreadShells();
  const projects = useProjects();
  const { environments } = useEnvironments();
  const startThreadTurn = useAtomCommand(threadEnvironment.startTurn, { reportFailure: false });
  const openedRef = useRef(false);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [selectedKeys, setSelectedKeys] = useState<ReadonlySet<string>>(new Set());
  const [keepShowingOnStartup, setKeepShowingOnStartup] = useState(true);

  const connectedEnvironmentIds = useMemo(
    () =>
      new Set(
        environments
          .filter((environment) => environment.connection.phase === "connected")
          .map((environment) => environment.environmentId),
      ),
    [environments],
  );
  const candidates = useMemo(
    () =>
      deriveStartupResumableThreads(threads).filter((thread) =>
        connectedEnvironmentIds.has(thread.environmentId),
      ),
    [connectedEnvironmentIds, threads],
  );
  const projectTitleByKey = useMemo(
    () =>
      new Map(
        projects.map((project) => [threadKey(project.environmentId, project.id), project.title]),
      ),
    [projects],
  );
  const environmentLabelById = useMemo(
    () =>
      new Map(environments.map((environment) => [environment.environmentId, environment.label])),
    [environments],
  );

  useEffect(() => {
    if (
      openedRef.current ||
      !settingsHydrated ||
      !shellsBootstrapped ||
      !showOnStartup ||
      candidates.length === 0 ||
      wasPromptHandledThisStartup()
    ) {
      return;
    }
    openedRef.current = true;
    markPromptHandledThisStartup();
    setKeepShowingOnStartup(true);
    setSelectedKeys(
      new Set(candidates.map((thread) => threadKey(thread.environmentId, thread.id))),
    );
    setOpen(true);
  }, [candidates, settingsHydrated, shellsBootstrapped, showOnStartup]);

  const candidateKeys = useMemo(
    () => candidates.map((thread) => threadKey(thread.environmentId, thread.id)),
    [candidates],
  );

  // Keep the footer count honest when only some candidates drain away. Selection
  // is seeded once on open, so without this the stale keys keep the Resume
  // button enabled over rows that are no longer listed.
  useEffect(() => {
    if (!open || busy) return;
    setSelectedKeys((current) => {
      const pruned = pruneStartupResumeSelection(current, candidateKeys);
      return pruned.size === current.size ? current : pruned;
    });
  }, [busy, candidateKeys, open]);

  const persistShowOnStartupChoice = () => {
    if (keepShowingOnStartup !== showOnStartup) {
      updateClientSettings({ showResumeThreadsOnStartup: keepShowingOnStartup });
    }
  };

  const dismiss = () => {
    if (busy) return;
    persistShowOnStartupChoice();
    setOpen(false);
  };

  // Close once there is nothing left to resume — the threads were resumed
  // elsewhere, their environment dropped, or they left the store. Routed through
  // `dismiss` so the "Show on startup" choice is still persisted, and gated on
  // `busy` so it cannot race `resumeSelected`, which drains the list itself.
  useEffect(() => {
    if (!shouldAutoCloseStartupResume({ open, busy, candidateCount: candidates.length })) return;
    persistShowOnStartupChoice();
    setOpen(false);
  }, [busy, candidates.length, open, keepShowingOnStartup, showOnStartup]);

  const resumeSelected = async () => {
    if (busy) return;
    const selected = candidates.filter((thread) =>
      selectedKeys.has(threadKey(thread.environmentId, thread.id)),
    );
    if (selected.length === 0) return;

    setBusy(true);
    persistShowOnStartupChoice();
    const results = await Promise.all(
      selected.map(async (thread) => {
        try {
          const createdAt = new Date().toISOString();
          const result = await startThreadTurn({
            environmentId: thread.environmentId,
            input: {
              threadId: thread.id,
              message: {
                messageId: newMessageId(),
                role: "user",
                text: "resume",
                attachments: [],
              },
              modelSelection: thread.modelSelection,
              titleSeed: thread.title,
              runtimeMode: thread.runtimeMode,
              interactionMode: thread.interactionMode,
              createdAt,
            },
          });
          if (result._tag === "Success") {
            return null;
          }
          if (isAtomCommandInterrupted(result)) {
            return `${thread.title}: resume was interrupted`;
          }
          const failure = squashAtomCommandFailure(result);
          return `${thread.title}: ${
            failure instanceof Error ? failure.message : "could not resume"
          }`;
        } catch (error) {
          return `${thread.title}: ${error instanceof Error ? error.message : "could not resume"}`;
        }
      }),
    );
    const failures = results.filter((result): result is string => result !== null);
    setBusy(false);
    setOpen(false);

    if (failures.length === 0) {
      toastManager.add(
        stackedThreadToast({
          type: "success",
          title: `Resumed ${selected.length} ${selected.length === 1 ? "thread" : "threads"}`,
        }),
      );
      return;
    }
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title:
          failures.length === selected.length
            ? "Could not resume selected threads"
            : `Resumed ${selected.length - failures.length} of ${selected.length} threads`,
        description: failures.slice(0, 3).join("\n"),
      }),
    );
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) dismiss();
      }}
    >
      <DialogPopup className="w-[min(34rem,calc(100vw-2rem))]" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>Resume unfinished threads?</DialogTitle>
          <DialogDescription>
            Solla Code found work that stopped before its response completed. Choose which threads
            should continue now.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-2">
          {candidates.map((thread) => {
            const key = threadKey(thread.environmentId, thread.id);
            const projectTitle =
              projectTitleByKey.get(threadKey(thread.environmentId, thread.projectId)) ??
              "Unknown project";
            const environmentLabel = environmentLabelById.get(thread.environmentId);
            return (
              <label
                key={key}
                className="flex cursor-pointer items-start gap-3 rounded-xl border border-border/70 bg-muted/20 p-3 hover:bg-muted/35"
              >
                <Checkbox
                  checked={selectedKeys.has(key)}
                  onCheckedChange={(checked) => {
                    setSelectedKeys((current) => {
                      const next = new Set(current);
                      if (checked) next.add(key);
                      else next.delete(key);
                      return next;
                    });
                  }}
                  aria-label={`Resume ${thread.title}`}
                />
                <span className="min-w-0">
                  <span className="block truncate font-medium text-sm">{thread.title}</span>
                  <span className="block truncate text-muted-foreground text-xs">
                    {projectTitle}
                    {environmentLabel ? ` · ${environmentLabel}` : ""}
                  </span>
                </span>
              </label>
            );
          })}
          <label className="mt-4 flex cursor-pointer items-center gap-2 text-sm">
            <Checkbox
              checked={keepShowingOnStartup}
              onCheckedChange={(checked) => setKeepShowingOnStartup(Boolean(checked))}
              aria-label="Show resume prompt on startup"
            />
            <span>Show on startup</span>
          </label>
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={dismiss}>
            No
          </Button>
          <Button disabled={busy || selectedKeys.size === 0} onClick={() => void resumeSelected()}>
            {busy ? "Resuming…" : `Resume${selectedKeys.size > 0 ? ` (${selectedKeys.size})` : ""}`}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
