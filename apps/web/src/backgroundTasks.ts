import { create } from "zustand";

export type BackgroundTaskStatus = "loading" | "transcribing";

export interface VoiceTranscriptionBackgroundTask {
  readonly id: string;
  readonly kind: "voice-transcription";
  /** Composer surface that owns the recording, draft update, and busy UI. */
  readonly ownerKey: string;
  readonly title: string;
  readonly status: BackgroundTaskStatus;
  readonly progress: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface BackgroundTaskStore {
  readonly tasks: readonly VoiceTranscriptionBackgroundTask[];
  startVoiceTranscription: (ownerKey: string) => string | null;
  updateTask: (
    id: string,
    update: Partial<Pick<VoiceTranscriptionBackgroundTask, "status" | "progress">>,
  ) => void;
  removeTask: (id: string) => void;
}

let nextTaskId = 1;

export function isBackgroundTaskActive(status: BackgroundTaskStatus): boolean {
  return status === "loading" || status === "transcribing";
}

export const useBackgroundTaskStore = create<BackgroundTaskStore>((set) => ({
  tasks: [],
  startVoiceTranscription: (ownerKey) => {
    const normalizedOwnerKey = ownerKey.trim();
    if (normalizedOwnerKey.length === 0) return null;
    const now = new Date().toISOString();
    let id: string | null = null;
    set((state) => {
      if (state.tasks.some((task) => isBackgroundTaskActive(task.status))) {
        return state;
      }
      const nextId = `voice-transcription-${Date.now()}-${nextTaskId++}`;
      id = nextId;
      return {
        tasks: [
          ...state.tasks,
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
  removeTask: (id) => {
    set((state) => ({ tasks: state.tasks.filter((task) => task.id !== id) }));
  },
}));

export function startVoiceTranscriptionBackgroundTask(ownerKey: string): string | null {
  return useBackgroundTaskStore.getState().startVoiceTranscription(ownerKey);
}

export function finishVoiceTranscriptionBackgroundTask(id: string): void {
  useBackgroundTaskStore.getState().removeTask(id);
}

export function resetBackgroundTasksForTests(): void {
  nextTaskId = 1;
  useBackgroundTaskStore.setState({ tasks: [] });
}
