import { NonNegativeInt } from "@t3tools/contracts";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { toPersistenceSqlError } from "../Errors.ts";

import {
  ProjectionStateRepository,
  type ProjectionStateRepositoryShape,
  GetProjectionStateInput,
  ProjectionState,
  UpsertProjectionStatesInput,
} from "../Services/ProjectionState.ts";

const MinLastAppliedSequenceRowSchema = Schema.Struct({
  minLastAppliedSequence: Schema.NullOr(NonNegativeInt),
});

const makeProjectionStateRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // One multi-row statement per event: every projector advances to the same
  // cursor, and the per-projector statements were most of an event's writes.
  const upsertProjectionStateRows = SqlSchema.void({
    Request: UpsertProjectionStatesInput,
    execute: ({ projectors, lastAppliedSequence, updatedAt }) =>
      sql`
        INSERT INTO projection_state ${sql.insert(
          projectors.map((projector) => ({
            projector,
            last_applied_sequence: lastAppliedSequence,
            updated_at: updatedAt,
          })),
        )}
        ON CONFLICT (projector)
        DO UPDATE SET
          last_applied_sequence = excluded.last_applied_sequence,
          updated_at = excluded.updated_at
      `,
  });

  const getProjectionStateRow = SqlSchema.findOneOption({
    Request: GetProjectionStateInput,
    Result: ProjectionState,
    execute: ({ projector }) =>
      sql`
        SELECT
          projector,
          last_applied_sequence AS "lastAppliedSequence",
          updated_at AS "updatedAt"
        FROM projection_state
        WHERE projector = ${projector}
      `,
  });

  const listProjectionStateRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionState,
    execute: () =>
      sql`
        SELECT
          projector,
          last_applied_sequence AS "lastAppliedSequence",
          updated_at AS "updatedAt"
        FROM projection_state
        ORDER BY projector ASC
      `,
  });

  const readMinLastAppliedSequence = SqlSchema.findOne({
    Request: Schema.Void,
    Result: MinLastAppliedSequenceRowSchema,
    execute: () =>
      sql`
        SELECT
          MIN(last_applied_sequence) AS "minLastAppliedSequence"
        FROM projection_state
      `,
  });

  const upsertMany: ProjectionStateRepositoryShape["upsertMany"] = (input) =>
    input.projectors.length === 0
      ? Effect.void
      : upsertProjectionStateRows(input).pipe(
          Effect.mapError(toPersistenceSqlError("ProjectionStateRepository.upsertMany:query")),
        );

  const getByProjector: ProjectionStateRepositoryShape["getByProjector"] = (input) =>
    getProjectionStateRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionStateRepository.getByProjector:query")),
    );

  const listAll: ProjectionStateRepositoryShape["listAll"] = () =>
    listProjectionStateRows(undefined).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionStateRepository.listAll:query")),
    );

  const minLastAppliedSequence: ProjectionStateRepositoryShape["minLastAppliedSequence"] = () =>
    readMinLastAppliedSequence(undefined).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionStateRepository.minLastAppliedSequence:query"),
      ),
      Effect.map((row) => row.minLastAppliedSequence),
    );

  return {
    upsertMany,
    getByProjector,
    listAll,
    minLastAppliedSequence,
  } satisfies ProjectionStateRepositoryShape;
});

export const ProjectionStateRepositoryLive = Layer.effect(
  ProjectionStateRepository,
  makeProjectionStateRepository,
);
