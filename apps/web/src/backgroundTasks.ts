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
}

export type BackgroundTask = ThreadExportBackgroundTask | VoiceTranscriptionBackgroundTask;

interface BackgroundTaskStore {
  readonly tasks: readonly BackgroundTask[];
  startThreadExport: (threadRef: ScopedThreadRef, title: string) => string;
  startVoiceTranscription: () => string;
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
const VOICE_TRANSCRIPTION_TASK_ID = "voice-transcription";

export function isBackgroundTaskActive(status: BackgroundTaskStatus): boolean {
  return !["completed", "failed", "cancelled"].includes(status);
}

export function canCancelBackgroundTask(status: BackgroundTaskStatus): boolean {
  return ["queued", "loading", "awaiting-confirmation", "serializing"].includes(status);
}

export const useBackgroundTaskStore = create<BackgroundTaskStore>((set) => ({
  tasks: [],
  startThreadExport: (threadRef, title) => {
    const now = new Date().toISOString();
    const id = `thread-export-${Date.now()}-${nextTaskId++}`;
    set((state) => ({
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
  startVoiceTranscription: () => {
    const now = new Date().toISOString();
    set((state) => ({
      tasks: [
        ...state.tasks.filter((task) => task.kind !== "voice-transcription"),
        {
          id: VOICE_TRANSCRIPTION_TASK_ID,
          kind: "voice-transcription",
          title: "Voice transcription",
          status: "loading",
          progress: 5,
          createdAt: now,
          updatedAt: now,
        },
      ],
    }));
    return VOICE_TRANSCRIPTION_TASK_ID;
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

export function startVoiceTranscriptionBackgroundTask(): string {
  return useBackgroundTaskStore.getState().startVoiceTranscription();
}

export function finishVoiceTranscriptionBackgroundTask(id: string): void {
  useBackgroundTaskStore.getState().removeTask(id);
}

export function resetBackgroundTasksForTests(): void {
  nextTaskId = 1;
  useBackgroundTaskStore.setState({ tasks: [] });
}
