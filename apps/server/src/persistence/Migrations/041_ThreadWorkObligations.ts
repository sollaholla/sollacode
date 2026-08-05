import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Durable background work is intentionally independent from renderer state.
 * A row records that a thread must eventually continue; a separate runtime
 * lease records whether live provider/tool resources must be retained now.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS thread_work_obligations (
      obligation_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      source_turn_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (
        kind IN (
          'agent-continuation',
          'startup-resume',
          'authentication-resume',
          'provider-retry',
          'active-turn-recovery'
        )
      ),
      state TEXT NOT NULL CHECK (
        state IN (
          'pending',
          'claimed',
          'executing',
          'sleeping',
          'blocked-authentication',
          'waiting-approval',
          'waiting-user-input',
          'completed',
          'cancelled'
        )
      ),
      provider_instance_id TEXT NOT NULL,
      attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
      next_attempt_at TEXT,
      claimed_at TEXT,
      lease_expires_at TEXT,
      blocked_reason TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      CHECK (
        (state = 'sleeping'
          AND next_attempt_at IS NOT NULL
          AND claimed_at IS NULL
          AND lease_expires_at IS NULL)
        OR (state IN ('claimed', 'executing')
          AND next_attempt_at IS NULL
          AND claimed_at IS NOT NULL
          AND lease_expires_at IS NOT NULL)
        OR (state IN (
            'pending',
            'blocked-authentication',
            'waiting-approval',
            'waiting-user-input',
            'completed',
            'cancelled'
          )
          AND next_attempt_at IS NULL
          AND claimed_at IS NULL
          AND lease_expires_at IS NULL)
      ),
      CHECK (
        length(created_at) = 24
        AND created_at GLOB '????-??-??T??:??:??.???Z'
        AND julianday(created_at) IS NOT NULL
      ),
      CHECK (
        length(updated_at) = 24
        AND updated_at GLOB '????-??-??T??:??:??.???Z'
        AND julianday(updated_at) IS NOT NULL
      ),
      CHECK (
        next_attempt_at IS NULL OR (
          length(next_attempt_at) = 24
          AND next_attempt_at GLOB '????-??-??T??:??:??.???Z'
          AND julianday(next_attempt_at) IS NOT NULL
        )
      ),
      CHECK (
        claimed_at IS NULL OR (
          length(claimed_at) = 24
          AND claimed_at GLOB '????-??-??T??:??:??.???Z'
          AND julianday(claimed_at) IS NOT NULL
        )
      ),
      CHECK (
        lease_expires_at IS NULL OR (
          length(lease_expires_at) = 24
          AND lease_expires_at GLOB '????-??-??T??:??:??.???Z'
          AND julianday(lease_expires_at) IS NOT NULL
        )
      ),
      UNIQUE (thread_id, source_turn_id, kind)
    )
  `;

  // A thread may have several future obligations, but only one may own live
  // provider execution at a time. SQLite enforces this across scheduler races.
  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_thread_work_obligations_one_active_thread
    ON thread_work_obligations(thread_id)
    WHERE state IN (
      'claimed',
      'executing',
      'sleeping',
      'blocked-authentication',
      'waiting-approval',
      'waiting-user-input'
    )
  `;

  // Scheduler reads are provider-scoped, due-time ordered, and bounded.
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_thread_work_obligations_schedulable
    ON thread_work_obligations(
      provider_instance_id,
      state,
      next_attempt_at,
      created_at,
      obligation_id
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_thread_work_obligations_thread_state
    ON thread_work_obligations(thread_id, state, created_at, obligation_id)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_thread_work_obligations_provider_state_updated
    ON thread_work_obligations(provider_instance_id, state, updated_at, obligation_id)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_thread_work_obligations_terminal_prune
    ON thread_work_obligations(state, updated_at)
    WHERE state IN ('completed', 'cancelled')
  `;
});
