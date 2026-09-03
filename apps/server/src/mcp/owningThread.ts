import type { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";

/**
 * The thread whose shared resources an invocation acts on.
 *
 * A connected side chat works on its PARENT's things. It was forked from that
 * chat to help with that chat's work, so a resource created under the side
 * chat's own id is stranded in a surface nobody revisits — and, for anything
 * the user is meant to watch, invisible to them. Side chats already inherit the
 * parent's `browserProfileThreadId`, so this is the same rule applied to what
 * that profile is used for.
 *
 * The parent must still exist and still claim the side chat. Promotion
 * deliberately clears the `isSideChat` edge, so a promoted (disconnected) side
 * chat, or one whose parent is gone, falls back to itself. That is also why
 * this is resolved per call rather than once when a session is issued.
 */
export const resolveOwningThreadIdWith = Effect.fn("mcp.resolveOwningThreadId")(function* (
  projections: ProjectionSnapshotQuery.ProjectionSnapshotQuery["Service"],
  invocationThreadId: ThreadId,
) {
  const shell = yield* projections
    .getThreadShellById(invocationThreadId)
    .pipe(Effect.orElseSucceed(() => Option.none()));
  if (Option.isNone(shell)) return invocationThreadId;
  const parentThreadId =
    shell.value.isSideChat === true ? (shell.value.sideChatParentThreadId ?? null) : null;
  if (parentThreadId === null) return invocationThreadId;
  const parent = yield* projections
    .getThreadShellById(parentThreadId)
    .pipe(Effect.orElseSucceed(() => Option.none()));
  return Option.isSome(parent) ? parentThreadId : invocationThreadId;
});

/** {@link resolveOwningThreadIdWith} for callers that can require the service. */
export const resolveOwningThreadId = Effect.fn("mcp.resolveOwningThreadId.service")(function* (
  invocationThreadId: ThreadId,
) {
  const projections = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  return yield* resolveOwningThreadIdWith(projections, invocationThreadId);
});
