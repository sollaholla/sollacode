import { describe, expect, it } from "vite-plus/test";
import {
  finishVoiceTranscriptionBackgroundTask,
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
});
