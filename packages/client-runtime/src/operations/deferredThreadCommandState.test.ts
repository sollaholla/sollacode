import { expect, it } from "vite-plus/test";
import {
  CommandId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationShellSnapshot,
} from "@t3tools/contracts";
import type { DeferredThreadCommandEntry } from "../platform/persistence.ts";
import { projectDeferredThreadSnapshot } from "./deferredThreadCommandState.ts";
import * as Schema from "effect/Schema";
import {
  DeferredThreadCommandEntriesDocument,
  compactDeferredThreadCommands,
} from "./deferredThreadCommands.ts";
const thread = {
  id: ThreadId.make("thread-1"),
  projectId: ProjectId.make("project-1"),
  title: "Test Thread",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
  runtimeMode: "full-access" as const,
  interactionMode: "default" as const,
  branch: null,
  worktreePath: null,
  latestTurn: null,
  createdAt: "2026-04-01T00:00:00.000Z",
  updatedAt: "2026-04-01T00:00:00.000Z",
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  latestUserMessageAt: null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  hasActionableProposedPlan: false,
  session: null,
} as const;

const snapshot: OrchestrationShellSnapshot = {
  snapshotSequence: 1,
  projects: [],
  threads: [thread],
  updatedAt: thread.updatedAt,
};
const entry = (
  type: "thread.archive" | "thread.unarchive" | "thread.delete",
): DeferredThreadCommandEntry => ({
  command: { type, threadId: thread.id, commandId: CommandId.make(type) },
  enqueuedAt: "2026-09-14T14:00:00.000Z",
  thread,
});
it("moves an offline archive immediately from active to archived without changing the server snapshot", () => {
  const pending = [entry("thread.archive")];
  expect(projectDeferredThreadSnapshot(snapshot, pending, false).threads).toEqual([]);
  expect(
    projectDeferredThreadSnapshot({ ...snapshot, threads: [] }, pending, true).threads[0]
      ?.archivedAt,
  ).toBe(pending[0]?.enqueuedAt);
  expect(snapshot.threads[0]?.archivedAt).toBeNull();
});
it("restore replaces archive and restores its persisted row even with an empty cached list", () => {
  const pending = compactDeferredThreadCommands(
    [entry("thread.archive")],
    entry("thread.unarchive"),
  );
  expect(pending.map((row) => row.command.type)).toEqual(["thread.unarchive"]);
  expect(
    projectDeferredThreadSnapshot({ ...snapshot, threads: [] }, pending, false).threads,
  ).toEqual([thread]);
  expect(projectDeferredThreadSnapshot(snapshot, pending, true).threads).toEqual([]);
});
it("delete immediately hides the thread in both lists", () => {
  for (const archived of [false, true])
    expect(
      projectDeferredThreadSnapshot(snapshot, [entry("thread.delete")], archived).threads,
    ).toEqual([]);
});

it("retains the optimistic row through the persisted queue schema", () => {
  const document = Schema.fromJsonString(DeferredThreadCommandEntriesDocument);
  const original = [entry("thread.unarchive")];
  const encoded = Schema.encodeSync(document)(original);
  const decoded = Schema.decodeUnknownSync(document)(encoded);
  expect(decoded[0]?.thread?.id).toBe(thread.id);
  expect(
    projectDeferredThreadSnapshot(
      { ...snapshot, threads: [] },
      decoded as readonly DeferredThreadCommandEntry[],
      false,
    ).threads[0]?.id,
  ).toBe(thread.id);
});
