/** Server-owned expiry, including tabs whose renderer or remote client disconnected. */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { SqlClient } from "effect/unstable/sql";
import type { PreviewSessionSnapshot } from "@t3tools/contracts";
import { PreviewManager } from "./Manager.ts";

export interface PreviewAttentionOwner {
  readonly threadId: string;
  readonly url: string | null;
}

export function protectedPreviewTabIds(
  sessions: ReadonlyArray<PreviewSessionSnapshot>,
  attention: ReadonlyArray<PreviewAttentionOwner>,
): ReadonlySet<string> {
  const protectedIds = new Set<string>();
  for (const owner of attention) {
    const ownedTabs = sessions.filter((session) => session.threadId === owner.threadId);
    const linkedTabs = owner.url
      ? ownedTabs.filter((session) => {
          if (session.navStatus._tag === "Idle") return false;
          try {
            // Sign-in can advance through paths without changing the site.
            return new URL(owner.url!).origin === new URL(session.navStatus.url).origin;
          } catch {
            return false;
          }
        })
      : [];
    // Legacy cards name only a chat. If their link no longer matches a tab
    // (for example an OAuth redirect), preserve that chat's tabs until the
    // card resolves rather than guessing which page can safely be destroyed.
    for (const session of linkedTabs.length > 0 ? linkedTabs : ownedTabs) {
      protectedIds.add(session.tabId);
    }
  }
  return protectedIds;
}

export const makeSweep = Effect.gen(function* () {
  const manager = yield* PreviewManager;
  const sql = yield* SqlClient.SqlClient;
  return Effect.fn("PreviewExpiry.sweep")(function* () {
    const { sessions } = yield* manager.list({});
    if (sessions.length === 0) return [];
    // Follow the same one-parent browser ownership rule as the automation
    // broker. This includes pending approvals raised by connected side chats.
    const attention = yield* sql<PreviewAttentionOwner>`
      WITH attention(thread_id, url) AS (
        SELECT thread_id, NULL FROM projection_threads
        WHERE pending_approval_count > 0 OR pending_user_input_count > 0
        UNION ALL
        SELECT a.thread_id, b.url FROM vm_agent_blockers b
        JOIN vm_agents a ON a.vm_agent_id = b.vm_agent_id
        WHERE b.resolved_at IS NULL AND a.thread_id IS NOT NULL
      )
      SELECT CASE WHEN t.is_side_chat = 1 AND parent.thread_id IS NOT NULL
        THEN parent.thread_id ELSE attention.thread_id END AS "threadId", attention.url
      FROM attention
      LEFT JOIN projection_threads t ON t.thread_id = attention.thread_id
      LEFT JOIN projection_threads parent ON parent.thread_id = t.side_chat_parent_thread_id
    `;
    return yield* manager.expireIdle(protectedPreviewTabIds(sessions, attention));
  });
});

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const sweep = yield* makeSweep;
    // No model turns, browser frame polling, or client-side countdown renders.
    // If the protection query fails, skip this sweep rather than closing a gate.
    yield* Effect.forkScoped(
      Effect.forever(
        Effect.gen(function* () {
          yield* Effect.sleep("1 minute");
          yield* sweep().pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("preview.expiry-sweep-failed", { cause }),
            ),
          );
        }),
      ),
    );
  }),
);
