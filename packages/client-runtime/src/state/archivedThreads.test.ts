import { EnvironmentId, type OrchestrationShellSnapshot } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult, Atom, AtomRegistry } from "effect/unstable/reactivity";
import { expect, it } from "vite-plus/test";

import {
  createArchivedThreadSnapshotsAtomFamily,
  makeArchivedThreadsEnvironmentKey,
  parseArchivedThreadsEnvironmentKey,
  planArchivedThreadCleanup,
} from "./archivedThreads.ts";

it("round-trips environment keys in sorted order", () => {
  const envA = EnvironmentId.make("env-a");
  const envB = EnvironmentId.make("env-b");
  const key = makeArchivedThreadsEnvironmentKey([envB, envA]);

  expect(parseArchivedThreadsEnvironmentKey(key)).toEqual([envA, envB]);
});

it("does not expose an archived snapshot failure message", () => {
  const environmentId = EnvironmentId.make("env-sensitive");
  const snapshotsAtom = createArchivedThreadSnapshotsAtomFamily<Error>({
    getSnapshotAtom: () =>
      Atom.make(
        AsyncResult.failure<OrchestrationShellSnapshot, Error>(
          Cause.fail(new Error("credential=secret-value")),
        ),
      ),
    labelPrefix: "test:archived-thread-snapshots",
  });
  const registry = AtomRegistry.make();

  expect(registry.get(snapshotsAtom(makeArchivedThreadsEnvironmentKey([environmentId])))).toEqual({
    snapshots: [],
    error: "Failed to load archived threads.",
    isLoading: false,
  });

  registry.dispose();
});

it("plans one cleanup per environment up to the newest archive time it showed", () => {
  const mac = EnvironmentId.make("env-mac");
  const windows = EnvironmentId.make("env-windows");
  const snapshot = (
    threads: ReadonlyArray<{ readonly id: string; readonly archivedAt: string | null }>,
  ) =>
    ({
      snapshotSequence: 1,
      projects: [],
      threads,
      updatedAt: "2026-10-12T19:40:00.000Z",
    }) as unknown as OrchestrationShellSnapshot;

  const plan = planArchivedThreadCleanup([
    {
      environmentId: mac,
      snapshot: snapshot([
        { id: "old", archivedAt: "2026-10-10T23:19:55.165Z" },
        { id: "newest", archivedAt: "2026-10-12T19:39:23.880Z" },
        { id: "live", archivedAt: null },
      ]),
    },
    { environmentId: windows, snapshot: snapshot([]) },
  ]);

  expect(plan).toEqual([
    {
      environmentId: mac,
      threads: [
        { threadId: "old", archivedAt: "2026-10-10T23:19:55.165Z" },
        { threadId: "newest", archivedAt: "2026-10-12T19:39:23.880Z" },
      ],
      archivedBefore: "2026-10-12T19:39:23.880Z",
    },
  ]);
});
