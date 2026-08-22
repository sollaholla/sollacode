import { describe, expect, it } from "@effect/vitest";

import { grokTaskKillPayload, parseGrokBackgroundTaskNotification } from "./GrokBackgroundTasks.ts";

const liveBackgrounded = {
  sessionId: "session-example-1",
  update: {
    sessionUpdate: "task_backgrounded",
    tool_call_id: "call-task-1",
    task_id: "call-task-1",
    command:
      "# Check the tool exists and start host tests. Long-running.\nls -d /Applications/ExampleTool.app/Contents/MacOS/ExampleTool\ncd /Users/example/Projects/sample-app\nbash tools/scripts/host_tests.sh\n",
    cwd: "/Users/example/Projects/sample-app",
    output_file:
      "/Users/example/.grok/sessions/sample-app/session-example-1/terminal/call-task-1.log",
    description: "Run native host tests",
  },
};

const liveCompleted = {
  sessionId: "session-example-1",
  update: {
    sessionUpdate: "task_completed",
    task_snapshot: {
      task_id: "call-task-1",
      command: "bash tools/scripts/host_tests.sh",
      cwd: "/Users/example/Projects/sample-app",
      output:
        "\u001b[31m/Applications/Unity/Hub/Editor/6000.4.0f1/Unity.app/Contents/MacOS/Unity\u001b[39;49m\u001b[0m\n\n66 of 66 host checks passed\n",
      exit_code: 0,
      signal: null,
      completed: true,
      kind: "bash",
      explicitly_killed: false,
      description: "Run native host tests",
      is_backgrounded: true,
    },
    will_wake: false,
  },
};

describe("Grok background-task parsers", () => {
  it("maps a live _x.ai/session/update task_backgrounded payload to task.started", () => {
    expect(parseGrokBackgroundTaskNotification(liveBackgrounded, "_x.ai/session/update")).toEqual({
      kind: "started",
      taskId: "call-task-1",
      taskType: "local_bash",
      description: "Run native host tests",
    });
  });

  it("maps a live task_completed snapshot, including will_wake:false, to task.completed", () => {
    expect(parseGrokBackgroundTaskNotification(liveCompleted, "_x.ai/session/update")).toEqual({
      kind: "completed",
      taskId: "call-task-1",
      taskType: "local_bash",
      status: "completed",
      summary: "66 of 66 host checks passed",
    });
  });

  it("treats explicitly_killed as stopped and a nonzero exit as failed", () => {
    expect(
      parseGrokBackgroundTaskNotification({
        sessionUpdate: "task_completed",
        task_snapshot: {
          task_id: "bg-1",
          explicitly_killed: true,
          exit_code: 137,
          kind: "bash",
        },
      }),
    ).toEqual({
      kind: "completed",
      taskId: "bg-1",
      taskType: "local_bash",
      status: "stopped",
      summary: "Stopped",
    });

    expect(
      parseGrokBackgroundTaskNotification({
        sessionId: "s1",
        update: {
          sessionUpdate: "task_completed",
          task_snapshot: {
            task_id: "bg-2",
            exit_code: 1,
            kind: "bash",
          },
        },
      }),
    ).toEqual({
      kind: "completed",
      taskId: "bg-2",
      taskType: "local_bash",
      status: "failed",
      summary: "Exit 1",
    });
  });

  it("accepts dedicated _x.ai/task_* envelopes and numeric task ids", () => {
    expect(
      parseGrokBackgroundTaskNotification(
        {
          sessionId: "s1",
          sessionUpdate: "task_backgrounded",
          task_id: 42,
          command: "sleep 30",
        },
        "_x.ai/task_backgrounded",
      ),
    ).toEqual({
      kind: "started",
      taskId: "42",
      taskType: "local_bash",
      description: "sleep 30",
    });

    expect(
      parseGrokBackgroundTaskNotification(
        {
          sessionId: "s1",
          task_snapshot: {
            taskId: "42",
            completed: true,
            kind: "bash",
            exit_code: 0,
          },
        },
        "_x.ai/task_completed",
      ),
    ).toEqual({
      kind: "completed",
      taskId: "42",
      taskType: "local_bash",
      status: "completed",
      summary: "Completed",
    });
  });

  it("ignores unrelated xAI session updates", () => {
    expect(
      parseGrokBackgroundTaskNotification({
        sessionId: "s1",
        update: { sessionUpdate: "usage_update", used: 10, size: 100 },
      }),
    ).toBeUndefined();
  });

  it("builds the _x.ai/task/kill payload the CLI expects", () => {
    expect(grokTaskKillPayload({ sessionId: "sess-1", taskId: "task-1" })).toEqual({
      sessionId: "sess-1",
      taskId: "task-1",
    });
  });
});
