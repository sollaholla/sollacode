import { describe, expect, it } from "vite-plus/test";
import {
  completeVoiceTranscriptionBackgroundTask,
  dismissVoiceTranscriptionResult,
  finishVoiceTranscriptionBackgroundTask,
  isBackgroundTaskActive,
  resetBackgroundTasksForTests,
  startVoiceTranscriptionBackgroundTask,
  useBackgroundTaskStore,
} from "./backgroundTasks";

describe("voice transcription task store", () => {
  it("scopes one transient voice transcription task to its owning composer", () => {
    resetBackgroundTasksForTests();
    const first = startVoiceTranscriptionBackgroundTask("thread:main");
    const blocked = startVoiceTranscriptionBackgroundTask("thread:side-chat");

    expect(first).not.toBeNull();
    expect(blocked).toBeNull();
    expect(useBackgroundTaskStore.getState().tasks).toHaveLength(1);
    expect(useBackgroundTaskStore.getState().tasks[0]).toMatchObject({
      kind: "voice-transcription",
      ownerKey: "thread:main",
      status: "loading",
    });

    useBackgroundTaskStore.getState().updateTask(first!, {
      status: "transcribing",
      progress: 55,
    });
    finishVoiceTranscriptionBackgroundTask(first!);
    expect(useBackgroundTaskStore.getState().tasks).toEqual([]);

    const second = startVoiceTranscriptionBackgroundTask("thread:side-chat");
    expect(second).not.toBeNull();
    expect(second).not.toBe(first);
    expect(useBackgroundTaskStore.getState().tasks[0]).toMatchObject({
      ownerKey: "thread:side-chat",
    });
  });

  it("retains one ready result per composer without blocking the next recording", () => {
    resetBackgroundTasksForTests();
    const first = startVoiceTranscriptionBackgroundTask("thread:main");
    expect(first).not.toBeNull();
    expect(completeVoiceTranscriptionBackgroundTask(first!, "  First transcript.  ")).toBe(true);
    expect(useBackgroundTaskStore.getState().tasks[0]).toMatchObject({
      id: first,
      ownerKey: "thread:main",
      status: "ready",
      progress: 100,
      transcript: "First transcript.",
    });
    expect(isBackgroundTaskActive("ready")).toBe(false);

    const second = startVoiceTranscriptionBackgroundTask("thread:main");
    expect(second).not.toBeNull();
    expect(completeVoiceTranscriptionBackgroundTask(second!, "Second transcript.")).toBe(true);
    expect(useBackgroundTaskStore.getState().tasks).toEqual([
      expect.objectContaining({ id: second, transcript: "Second transcript.", status: "ready" }),
    ]);

    dismissVoiceTranscriptionResult(second!);
    expect(useBackgroundTaskStore.getState().tasks).toEqual([]);
  });

  it("does not turn an empty or already-finished task into a ready result", () => {
    resetBackgroundTasksForTests();
    const taskId = startVoiceTranscriptionBackgroundTask("thread:main");
    expect(taskId).not.toBeNull();
    expect(completeVoiceTranscriptionBackgroundTask(taskId!, "   ")).toBe(false);
    finishVoiceTranscriptionBackgroundTask(taskId!);
    expect(completeVoiceTranscriptionBackgroundTask(taskId!, "too late")).toBe(false);
    expect(useBackgroundTaskStore.getState().tasks).toEqual([]);
  });
});
