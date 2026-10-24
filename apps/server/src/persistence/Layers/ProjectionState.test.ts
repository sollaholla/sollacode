import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ProjectionStateRepository } from "../Services/ProjectionState.ts";
import { ProjectionStateRepositoryLive } from "./ProjectionState.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";

const layer = it.layer(
  Layer.mergeAll(
    ProjectionStateRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
    SqlitePersistenceMemory,
  ),
);

layer("ProjectionStateRepository", (it) => {
  it.effect("advances every listed projector cursor in one write", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionStateRepository;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`DELETE FROM projection_state WHERE projector LIKE 'test.%'`;

      yield* repository.upsertMany({
        projectors: ["test.a", "test.b"],
        lastAppliedSequence: 7,
        updatedAt: "2026-10-24T00:00:00.000Z",
      });
      yield* repository.upsertMany({
        projectors: ["test.b", "test.c"],
        lastAppliedSequence: 9,
        updatedAt: "2026-10-24T00:00:01.000Z",
      });
      yield* repository.upsertMany({
        projectors: [],
        lastAppliedSequence: 11,
        updatedAt: "2026-10-24T00:00:02.000Z",
      });

      const rows = (yield* repository.listAll()).filter((row) => row.projector.startsWith("test."));
      assert.deepStrictEqual(rows, [
        { projector: "test.a", lastAppliedSequence: 7, updatedAt: "2026-10-24T00:00:00.000Z" },
        { projector: "test.b", lastAppliedSequence: 9, updatedAt: "2026-10-24T00:00:01.000Z" },
        { projector: "test.c", lastAppliedSequence: 9, updatedAt: "2026-10-24T00:00:01.000Z" },
      ]);
    }),
  );
});
