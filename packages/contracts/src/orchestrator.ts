import { ProjectId, ThreadId } from "./baseSchemas.ts";

/**
 * Identity of the singleton voice/text orchestrator.
 *
 * The orchestrator is one agent that spans the whole workspace: it is spoken to
 * through the voice HUD, typed to through its own dedicated thread, and both
 * share a single transcript. Because it must be reachable the moment the app
 * opens — before any user thread exists — its identity is a fixed constant
 * rather than a generated id.
 *
 * Reserving a literal id is safe here: `ThreadId`/`ProjectId` are branded
 * trimmed-non-empty strings (see `baseSchemas.ts`), not UUIDs, so nothing
 * validates the shape. The prefix also cannot collide with the v4 UUIDs that
 * every other thread and project gets.
 */
export const ORCHESTRATOR_THREAD_ID: ThreadId = ThreadId.make("solla-orchestrator");

/**
 * The orchestrator gets its own project rather than borrowing the user's.
 *
 * `projection_threads.project_id` is NOT NULL and the decider's `requireProject`
 * refuses to create a thread against a missing project, so the orchestrator has
 * to live somewhere. Giving it a dedicated project means an ordinary
 * `project.delete` — which cascades a synthesized `thread.delete` to every
 * active thread it owns — can never reach it.
 */
export const ORCHESTRATOR_PROJECT_ID: ProjectId = ProjectId.make("solla-orchestrator");

export const ORCHESTRATOR_THREAD_TITLE = "Orchestrator";
export const ORCHESTRATOR_PROJECT_NAME = "Orchestrator";

/**
 * Mints a short-lived realtime client secret. The long-lived API key stays on
 * the server; only this ephemeral token reaches the browser. The backend is
 * chosen from Settings → Orchestrator → Voice provider (OpenAI or Grok/xAI).
 */
export const ORCHESTRATOR_REALTIME_TOKEN_PATH = "/api/orchestrator/realtime-token";

/**
 * Runs one shell command on the machine hosting the server and returns its
 * output, so the voice orchestrator can look around instead of asking the user
 * to. Read-only is an instruction given to the model, not enforced here — see
 * `readOnlyCommand.ts` for why, and for the narrow catastrophic-action guard
 * that is enforced.
 */
export const ORCHESTRATOR_RUN_COMMAND_PATH = "/api/orchestrator/run-command";

export const isOrchestratorThreadId = (threadId: string): boolean =>
  threadId === ORCHESTRATOR_THREAD_ID;

export const isOrchestratorProjectId = (projectId: string): boolean =>
  projectId === ORCHESTRATOR_PROJECT_ID;
