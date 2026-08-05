import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Migration 041 may already have run in a released desktop profile. Triggers
 * add the same lifecycle/timestamp invariants to those existing tables without
 * rebuilding or risking durable work rows.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TRIGGER IF NOT EXISTS trg_thread_work_obligations_validate_insert
    BEFORE INSERT ON thread_work_obligations
    WHEN NOT (
      (
        NEW.state = 'sleeping'
        AND NEW.next_attempt_at IS NOT NULL
        AND NEW.claimed_at IS NULL
        AND NEW.lease_expires_at IS NULL
      )
      OR (
        NEW.state IN ('claimed', 'executing')
        AND NEW.next_attempt_at IS NULL
        AND NEW.claimed_at IS NOT NULL
        AND NEW.lease_expires_at IS NOT NULL
      )
      OR (
        NEW.state IN (
          'pending',
          'blocked-authentication',
          'waiting-approval',
          'waiting-user-input',
          'completed',
          'cancelled'
        )
        AND NEW.next_attempt_at IS NULL
        AND NEW.claimed_at IS NULL
        AND NEW.lease_expires_at IS NULL
      )
    ) OR NOT (
      length(NEW.created_at) = 24
      AND NEW.created_at GLOB '????-??-??T??:??:??.???Z'
      AND julianday(NEW.created_at) IS NOT NULL
      AND length(NEW.updated_at) = 24
      AND NEW.updated_at GLOB '????-??-??T??:??:??.???Z'
      AND julianday(NEW.updated_at) IS NOT NULL
      AND (
        NEW.next_attempt_at IS NULL OR (
          length(NEW.next_attempt_at) = 24
          AND NEW.next_attempt_at GLOB '????-??-??T??:??:??.???Z'
          AND julianday(NEW.next_attempt_at) IS NOT NULL
        )
      )
      AND (
        NEW.claimed_at IS NULL OR (
          length(NEW.claimed_at) = 24
          AND NEW.claimed_at GLOB '????-??-??T??:??:??.???Z'
          AND julianday(NEW.claimed_at) IS NOT NULL
        )
      )
      AND (
        NEW.lease_expires_at IS NULL OR (
          length(NEW.lease_expires_at) = 24
          AND NEW.lease_expires_at GLOB '????-??-??T??:??:??.???Z'
          AND julianday(NEW.lease_expires_at) IS NOT NULL
        )
      )
    )
    BEGIN
      SELECT RAISE(ABORT, 'invalid thread work obligation');
    END
  `;

  yield* sql`
    CREATE TRIGGER IF NOT EXISTS trg_thread_work_obligations_validate_update
    BEFORE UPDATE ON thread_work_obligations
    WHEN NOT (
      (
        NEW.state = 'sleeping'
        AND NEW.next_attempt_at IS NOT NULL
        AND NEW.claimed_at IS NULL
        AND NEW.lease_expires_at IS NULL
      )
      OR (
        NEW.state IN ('claimed', 'executing')
        AND NEW.next_attempt_at IS NULL
        AND NEW.claimed_at IS NOT NULL
        AND NEW.lease_expires_at IS NOT NULL
      )
      OR (
        NEW.state IN (
          'pending',
          'blocked-authentication',
          'waiting-approval',
          'waiting-user-input',
          'completed',
          'cancelled'
        )
        AND NEW.next_attempt_at IS NULL
        AND NEW.claimed_at IS NULL
        AND NEW.lease_expires_at IS NULL
      )
    ) OR NOT (
      length(NEW.created_at) = 24
      AND NEW.created_at GLOB '????-??-??T??:??:??.???Z'
      AND julianday(NEW.created_at) IS NOT NULL
      AND length(NEW.updated_at) = 24
      AND NEW.updated_at GLOB '????-??-??T??:??:??.???Z'
      AND julianday(NEW.updated_at) IS NOT NULL
      AND (
        NEW.next_attempt_at IS NULL OR (
          length(NEW.next_attempt_at) = 24
          AND NEW.next_attempt_at GLOB '????-??-??T??:??:??.???Z'
          AND julianday(NEW.next_attempt_at) IS NOT NULL
        )
      )
      AND (
        NEW.claimed_at IS NULL OR (
          length(NEW.claimed_at) = 24
          AND NEW.claimed_at GLOB '????-??-??T??:??:??.???Z'
          AND julianday(NEW.claimed_at) IS NOT NULL
        )
      )
      AND (
        NEW.lease_expires_at IS NULL OR (
          length(NEW.lease_expires_at) = 24
          AND NEW.lease_expires_at GLOB '????-??-??T??:??:??.???Z'
          AND julianday(NEW.lease_expires_at) IS NOT NULL
        )
      )
    )
    BEGIN
      SELECT RAISE(ABORT, 'invalid thread work obligation');
    END
  `;
});
