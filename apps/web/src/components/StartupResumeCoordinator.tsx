import { useCallback, useEffect, useMemo, useRef } from "react";

import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";

import { useClientSettings, useClientSettingsHydrated } from "../hooks/useSettings";
import { newMessageId } from "../lib/utils";
import { RESUME_PROMPT } from "../resumePrompt";
import { useAllEnvironmentShellsBootstrapped, useThreadShells } from "../state/entities";
import { useEnvironments } from "../state/environments";
import { threadEnvironment } from "../state/threads";
import { useAtomCommand } from "../state/use-atom-command";
import { useStartupResumeStore } from "../startupResumeStore";
import { stackedThreadToast, toastManager } from "./ui/toast";
import {
  deriveStartupResumableThreads,
  isStartupAutoResumeRequested,
  isStartupAutoResumeStalled,
  shouldAutomaticallyResumeOnStartup,
  shouldClearStartupResumePending,
  startupAutoResumeIds,
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
  const autoResumeRequested = useMemo(() => isStartupAutoResumeRequested(window.location.href), []);
  const settingsHydrated = useClientSettingsHydrated();
  const showOnStartup = useClientSettings((settings) => settings.showResumeThreadsOnStartup);
  const shellsBootstrapped = useAllEnvironmentShellsBootstrapped();
  const threads = useThreadShells();
  const { environments } = useEnvironments();
  const startThreadTurn = useAtomCommand(threadEnvironment.startTurn, { reportFailure: false });
  const dispatchedRef = useRef(false);

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

  useEffect(() => {
    const pending = useStartupResumeStore.getState().pendingStartedAtByThreadKey;
    for (const key of Object.keys(pending)) {
      const thread = threads.find(
        (candidate) => threadKey(candidate.environmentId, candidate.id) === key,
      );
      if (!thread || shouldClearStartupResumePending(thread)) {
        useStartupResumeStore.getState().clearPending(key);
      }
    }
  }, [threads]);

  // Stalled entries must clear at the store, not per-consumer: the effect
  // above only re-runs when thread state changes, and in the exact stuck case
  // (resume dispatched, obligation dead, no CLI ever spawned) nothing about
  // the thread ever changes again. The sidebar and side-chat indicators read
  // the raw map, so without this sweep they spun forever.
  useEffect(() => {
    const interval = setInterval(() => {
      const pending = useStartupResumeStore.getState().pendingStartedAtByThreadKey;
      const nowMs = Date.now();
      for (const [key, startedAt] of Object.entries(pending)) {
        if (isStartupAutoResumeStalled({ startedAt, nowMs })) {
          useStartupResumeStore.getState().clearPending(key);
        }
      }
    }, 5_000);
    return () => clearInterval(interval);
  }, []);

  const resumeThreads = useCallback(
    async (selected: typeof candidates) => {
      if (selected.length === 0) return;

      useStartupResumeStore
        .getState()
        .markPending(selected.map((thread) => threadKey(thread.environmentId, thread.id)));
      const results = await Promise.all(
        selected.map(async (thread) => {
          const key = threadKey(thread.environmentId, thread.id);
          try {
            const createdAt = new Date().toISOString();
            const incompleteTurnId = thread.latestTurn?.turnId;
            const resumeIds =
              incompleteTurnId !== undefined
                ? startupAutoResumeIds({ threadId: thread.id, incompleteTurnId })
                : null;
            const result = await startThreadTurn({
              environmentId: thread.environmentId,
              input: {
                ...(resumeIds !== null ? { commandId: resumeIds.commandId } : {}),
                threadId: thread.id,
                message: {
                  messageId: resumeIds?.messageId ?? newMessageId(),
                  role: "user",
                  text: RESUME_PROMPT,
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
            useStartupResumeStore.getState().clearPending(key);
            if (isAtomCommandInterrupted(result)) {
              return `${thread.title}: resume was interrupted`;
            }
            const failure = squashAtomCommandFailure(result);
            return `${thread.title}: ${
              failure instanceof Error ? failure.message : "could not resume"
            }`;
          } catch (error) {
            useStartupResumeStore.getState().clearPending(key);
            return `${thread.title}: ${error instanceof Error ? error.message : "could not resume"}`;
          }
        }),
      );
      const failures = results.filter((result): result is string => result !== null);

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
    },
    [startThreadTurn],
  );

  useEffect(() => {
    if (
      dispatchedRef.current ||
      !settingsHydrated ||
      !shellsBootstrapped ||
      !shouldAutomaticallyResumeOnStartup({
        showOnStartup,
        autoResumeRequested,
      }) ||
      candidates.length === 0 ||
      wasPromptHandledThisStartup()
    ) {
      return;
    }
    dispatchedRef.current = true;
    markPromptHandledThisStartup();
    void resumeThreads(candidates);
  }, [
    autoResumeRequested,
    candidates,
    resumeThreads,
    settingsHydrated,
    shellsBootstrapped,
    showOnStartup,
  ]);

  return null;
}
