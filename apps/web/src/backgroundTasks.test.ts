import { describe, expect, it } from "vite-plus/test";
import type { ScopedThreadRef } from "@t3tools/contracts";

import {
  canCancelBackgroundTask,
  finishVoiceTranscriptionBackgroundTask,
  isBackgroundTaskActive,
  resetBackgroundTasksForTests,
  startVoiceTranscriptionBackgroundTask,
  useBackgroundTaskStore,
} from "./backgroundTasks";

const threadRef = {
  environmentId: "env-test",
  threadId: "thread-test",
} as ScopedThreadRef;

describe("background task store", () => {
  it("tracks export progress and completion output", () => {
    resetBackgroundTasksForTests();
    const id = useBackgroundTaskStore.getState().startThreadExport(threadRef, "Test thread");
    expect(useBackgroundTaskStore.getState().panelOpen).toBe(true);
    useBackgroundTaskStore.getState().updateTask(id, { status: "writing", progress: 80 });
    useBackgroundTaskStore.getState().updateTask(id, {
      status: "completed",
      progress: 100,
      outputPath: "/Downloads/Test.json",
    });

    expect(useBackgroundTaskStore.getState().tasks[0]).toMatchObject({
      status: "completed",
      progress: 100,
      outputPath: "/Downloads/Test.json",
    });
    expect(isBackgroundTaskActive("completed")).toBe(false);
  });

  it("cancels only before the non-interruptible file write", () => {
    resetBackgroundTasksForTests();
    const first = useBackgroundTaskStore.getState().startThreadExport(threadRef, "First");
    useBackgroundTaskStore.getState().cancelTask(first);
    expect(useBackgroundTaskStore.getState().tasks[0]?.status).toBe("cancelled");

    const second = useBackgroundTaskStore.getState().startThreadExport(threadRef, "Second");
    useBackgroundTaskStore.getState().updateTask(second, { status: "writing", progress: 85 });
    useBackgroundTaskStore.getState().cancelTask(second);
    expect(useBackgroundTaskStore.getState().tasks[1]?.status).toBe("writing");
    expect(canCancelBackgroundTask("writing")).toBe(false);
  });

  it("keeps one transient voice transcription task and removes it when complete", () => {
    resetBackgroundTasksForTests();
    const first = startVoiceTranscriptionBackgroundTask();
    const second = startVoiceTranscriptionBackgroundTask();

    expect(first).toBe(second);
    expect(useBackgroundTaskStore.getState().tasks).toHaveLength(1);
    expect(useBackgroundTaskStore.getState().tasks[0]).toMatchObject({
      kind: "voice-transcription",
      status: "loading",
    });

    useBackgroundTaskStore.getState().updateTask(second, {
      status: "transcribing",
      progress: 55,
    });
    finishVoiceTranscriptionBackgroundTask(second);
    expect(useBackgroundTaskStore.getState().tasks).toEqual([]);
  });
});
