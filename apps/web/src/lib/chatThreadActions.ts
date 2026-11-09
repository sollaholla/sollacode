import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import {
  isAgentBuilderThreadId,
  isOrchestratorThreadId,
  type EnvironmentId,
  type ProjectId,
  type ScopedProjectRef,
} from "@t3tools/contracts";
import type { DraftThreadEnvMode } from "../composerDraftStore";

interface ThreadContextLike {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  /** Set on a server thread; a draft has no chat of its own yet. */
  id?: string;
}

/**
 * The Orchestrator and the Agent Builder are each one standing chat. Their
 * folders are not places to start work, so nothing offers a new chat in them.
 */
export function isSingletonChat(threadId: string): boolean {
  return isOrchestratorThreadId(threadId) || isAgentBuilderThreadId(threadId);
}

interface NewThreadHandler {
  (
    projectRef: ScopedProjectRef,
    options?: {
      branch?: string | null;
      worktreePath?: string | null;
      envMode?: DraftThreadEnvMode;
      startFromOrigin?: boolean;
    },
  ): Promise<void>;
}

export interface ChatThreadActionContext {
  readonly activeDraftThread: ThreadContextLike | null;
  readonly activeThread: ThreadContextLike | undefined;
  readonly defaultProjectRef: ScopedProjectRef | null;
  readonly handleNewThread: NewThreadHandler;
}

export function resolveNewDraftStartFromOrigin(input: {
  envMode: DraftThreadEnvMode;
  newWorktreesStartFromOrigin: boolean;
}): boolean {
  return input.envMode === "worktree" && input.newWorktreesStartFromOrigin;
}

export function resolveThreadActionProjectRef(
  context: ChatThreadActionContext,
): ScopedProjectRef | null {
  if (context.activeThread?.id !== undefined && isSingletonChat(context.activeThread.id)) {
    return context.defaultProjectRef;
  }
  if (context.activeThread) {
    return scopeProjectRef(context.activeThread.environmentId, context.activeThread.projectId);
  }
  if (context.activeDraftThread) {
    return scopeProjectRef(
      context.activeDraftThread.environmentId,
      context.activeDraftThread.projectId,
    );
  }
  return context.defaultProjectRef;
}

// New threads inherit only the *project* from the current context. Branch,
// worktree, and env mode always come from the user's configured defaults —
// carrying them over from the viewed thread meant "new thread" silently
// reused checkouts and branches. Explicit affordances (branch toolbar's
// "new thread in this worktree") pass those options to handleNewThread
// directly instead.
export async function startNewThreadFromContext(
  context: ChatThreadActionContext,
): Promise<boolean> {
  const projectRef = resolveThreadActionProjectRef(context);
  if (!projectRef) {
    return false;
  }

  await context.handleNewThread(projectRef);
  return true;
}
