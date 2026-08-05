import type { ScopedThreadRef } from "@t3tools/contracts";
import { create } from "zustand";

export type BackgroundTaskStatus =
  | "queued"
  | "loading"
  | "transcribing"
  | "awaiting-confirmation"
  | "serializing"
  | "writing"
  | "completed"
  | "failed"
  | "cancelled";

interface BackgroundTaskBase {
  readonly id: string;
  readonly title: string;
  readonly status: BackgroundTaskStatus;
  readonly progress: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly error?: string;
}

export interface ThreadExportBackgroundTask extends BackgroundTaskBase {
  readonly kind: "thread-export";
  readonly threadRef: ScopedThreadRef;
  readonly outputPath?: string;
}

export interface VoiceTranscriptionBackgroundTask extends BackgroundTaskBase {
  readonly kind: "voice-transcription";
  /** Composer surface that owns the recording, draft update, and busy UI. */
  readonly ownerKey: string;
}

export type BackgroundTask = ThreadExportBackgroundTask | VoiceTranscriptionBackgroundTask;

interface BackgroundTaskStore {
  readonly tasks: readonly BackgroundTask[];
  readonly panelOpen: boolean;
  setPanelOpen: (open: boolean) => void;
  startThreadExport: (threadRef: ScopedThreadRef, title: string) => string;
  startVoiceTranscription: (ownerKey: string) => string | null;
  updateTask: (
    id: string,
    update: Partial<
      Pick<ThreadExportBackgroundTask, "status" | "progress" | "outputPath" | "error">
    >,
  ) => void;
  cancelTask: (id: string) => void;
  removeTask: (id: string) => void;
  clearFinished: () => void;
}

let nextTaskId = 1;

export function isBackgroundTaskActive(status: BackgroundTaskStatus): boolean {
  return !["completed", "failed", "cancelled"].includes(status);
}

export function canCancelBackgroundTask(status: BackgroundTaskStatus): boolean {
  return ["queued", "loading", "awaiting-confirmation", "serializing"].includes(status);
}

export const useBackgroundTaskStore = create<BackgroundTaskStore>((set) => ({
  tasks: [],
  panelOpen: false,
  setPanelOpen: (panelOpen) => set({ panelOpen }),
  startThreadExport: (threadRef, title) => {
    const now = new Date().toISOString();
    const id = `thread-export-${Date.now()}-${nextTaskId++}`;
    set((state) => ({
      panelOpen: true,
      tasks: [
        ...state.tasks,
        {
          id,
          kind: "thread-export",
          threadRef,
          title,
          status: "queued",
          progress: 0,
          createdAt: now,
          updatedAt: now,
        },
      ],
    }));
    return id;
  },
  startVoiceTranscription: (ownerKey) => {
    const normalizedOwnerKey = ownerKey.trim();
    if (normalizedOwnerKey.length === 0) return null;
    const now = new Date().toISOString();
    let id: string | null = null;
    set((state) => {
      if (
        state.tasks.some(
          (task) => task.kind === "voice-transcription" && isBackgroundTaskActive(task.status),
        )
      ) {
        return state;
      }
      const nextId = `voice-transcription-${Date.now()}-${nextTaskId++}`;
      id = nextId;
      return {
        tasks: [
          ...state.tasks.filter((task) => task.kind !== "voice-transcription"),
          {
            id: nextId,
            kind: "voice-transcription",
            ownerKey: normalizedOwnerKey,
            title: "Voice transcription",
            status: "loading",
            progress: 5,
            createdAt: now,
            updatedAt: now,
          },
        ],
      };
    });
    return id;
  },
  updateTask: (id, update) => {
    set((state) => ({
      tasks: state.tasks.map((task) =>
        task.id === id
          ? {
              ...task,
              ...update,
              progress: Math.max(0, Math.min(100, update.progress ?? task.progress)),
              updatedAt: new Date().toISOString(),
            }
          : task,
      ),
    }));
  },
  cancelTask: (id) => {
    set((state) => ({
      tasks: state.tasks.map((task) =>
        task.id === id && canCancelBackgroundTask(task.status)
          ? {
              ...task,
              status: "cancelled",
              updatedAt: new Date().toISOString(),
            }
          : task,
      ),
    }));
  },
  removeTask: (id) => {
    set((state) => ({ tasks: state.tasks.filter((task) => task.id !== id) }));
  },
  clearFinished: () => {
    set((state) => ({
      tasks: state.tasks.filter((task) => isBackgroundTaskActive(task.status)),
    }));
  },
}));

export function startThreadExportBackgroundTask(threadRef: ScopedThreadRef, title: string): string {
  return useBackgroundTaskStore.getState().startThreadExport(threadRef, title);
}

export function startVoiceTranscriptionBackgroundTask(ownerKey: string): string | null {
  return useBackgroundTaskStore.getState().startVoiceTranscription(ownerKey);
}

export function finishVoiceTranscriptionBackgroundTask(id: string): void {
  useBackgroundTaskStore.getState().removeTask(id);
}

export function resetBackgroundTasksForTests(): void {
  nextTaskId = 1;
  useBackgroundTaskStore.setState({ tasks: [], panelOpen: false });
}
