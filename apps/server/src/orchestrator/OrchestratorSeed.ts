import {
  CommandId,
  DEFAULT_MODEL,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  type ModelSelection,
  ORCHESTRATOR_PROJECT_ID,
  ORCHESTRATOR_PROJECT_NAME,
  ORCHESTRATOR_THREAD_ID,
  ORCHESTRATOR_THREAD_TITLE,
  ProviderInstanceId,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";

import * as ServerConfig from "../config.ts";
import * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";

// Inlined rather than imported from serverRuntimeStartup: that module is the
// one that calls this seed, so importing back into it would be circular.
const orchestratorDefaultModelSelection = (): ModelSelection => ({
  instanceId: ProviderInstanceId.make("codex"),
  model: DEFAULT_MODEL,
});

/**
 * Ensures the singleton orchestrator project + thread exist.
 *
 * Idempotent by construction: both commands are guarded by `requireProjectAbsent`
 * / `requireThreadAbsent` in the decider, so a second run fails the invariant and
 * is swallowed here. That is cheaper and less racy than querying first, and it
 * keeps the thread event-sourced — seeding the projection row directly would
 * leave a thread with no `thread.created` event, which `requireThreadAbsent`
 * would then refuse to repair.
 *
 * Note this deliberately does NOT run inside the `autoBootstrapProjectFromCwd`
 * branch: that flag defaults to false, and the orchestrator has to exist on
 * every install.
 */
export const seedOrchestratorThread = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const randomUUID = crypto.randomUUIDv4;
  const serverConfig = yield* ServerConfig.ServerConfig;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const orchestrationEngine = yield* OrchestrationEngine.OrchestrationEngineService;

  const existing = yield* projectionSnapshotQuery.getThreadShellById(ORCHESTRATOR_THREAD_ID);
  if (Option.isSome(existing)) {
    return { created: false } as const;
  }

  const createdAt = DateTime.formatIso(yield* DateTime.now);
  const modelSelection = orchestratorDefaultModelSelection();

  // A dedicated workspace root under the server state dir. It must be unique —
  // `requireActiveProjectWorkspaceRootAbsent` rejects a second project on the
  // same root — so borrowing `serverConfig.cwd` would collide with the
  // auto-bootstrapped project on machines where that flag is on.
  //
  // Read from the config rather than re-joined here: `ensureServerDirectories`
  // creates this path on every boot, and deriving it twice is how the two drift
  // into pointing at different directories.
  const workspaceRoot = serverConfig.orchestratorWorkspaceDir;

  const ignoreAlreadyExists = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.catchIf(
        (error): error is Extract<E, { readonly _tag: "OrchestrationCommandInvariantError" }> =>
          Predicate.isTagged(error, "OrchestrationCommandInvariantError"),
        (error) =>
          Effect.logDebug("orchestrator seed skipped an already-present aggregate", {
            detail: (error as { readonly detail?: string }).detail,
          }),
      ),
    );

  yield* ignoreAlreadyExists(
    orchestrationEngine.dispatch({
      type: "project.create",
      commandId: CommandId.make(yield* randomUUID),
      projectId: ORCHESTRATOR_PROJECT_ID,
      title: ORCHESTRATOR_PROJECT_NAME,
      workspaceRoot,
      defaultModelSelection: modelSelection,
      createdAt,
    }),
  );

  yield* ignoreAlreadyExists(
    orchestrationEngine.dispatch({
      type: "thread.create",
      commandId: CommandId.make(yield* randomUUID),
      threadId: ORCHESTRATOR_THREAD_ID,
      projectId: ORCHESTRATOR_PROJECT_ID,
      title: ORCHESTRATOR_THREAD_TITLE,
      modelSelection,
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "full-access",
      branch: null,
      worktreePath: null,
      createdAt,
    }),
  );

  return { created: true } as const;
});
