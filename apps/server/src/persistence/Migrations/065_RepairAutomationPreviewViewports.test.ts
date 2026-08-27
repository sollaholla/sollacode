import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("065_RepairAutomationPreviewViewports", (it) => {
  it.effect("repairs the obsolete automation default without changing other viewports", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const updatedAt = "2026-08-27T12:00:00.000Z";

      yield* runMigrations({ toMigrationInclusive: 64 });
      yield* sql`
        INSERT INTO preview_sessions (thread_id, tab_id, snapshot_json, updated_at)
        VALUES
          (
            'thread-one', 'automation-default',
            '{"threadId":"thread-one","tabId":"automation-default","navStatus":{"_tag":"Idle"},"canGoBack":false,"canGoForward":false,"viewport":{"_tag":"freeform","width":1280,"height":800},"updatedAt":"2026-08-27T12:00:00.000Z"}',
            ${updatedAt}
          ),
          (
            'thread-one', 'custom-size',
            '{"threadId":"thread-one","tabId":"custom-size","navStatus":{"_tag":"Idle"},"canGoBack":false,"canGoForward":false,"viewport":{"_tag":"freeform","width":1280,"height":801},"updatedAt":"2026-08-27T12:00:00.000Z"}',
            ${updatedAt}
          ),
          (
            'thread-one', 'explicit-preset',
            '{"threadId":"thread-one","tabId":"explicit-preset","navStatus":{"_tag":"Idle"},"canGoBack":false,"canGoForward":false,"viewport":{"_tag":"preset","presetId":"laptop-1280x800","width":1280,"height":800},"updatedAt":"2026-08-27T12:00:00.000Z"}',
            ${updatedAt}
          )
      `;

      yield* runMigrations({ toMigrationInclusive: 65 });

      const rows = yield* sql<{
        readonly tabId: string;
        readonly viewport: string;
      }>`
        SELECT
          tab_id AS "tabId",
          json_extract(snapshot_json, '$.viewport') AS viewport
        FROM preview_sessions
        ORDER BY tab_id
      `;
      assert.deepStrictEqual(rows, [
        { tabId: "automation-default", viewport: '{"_tag":"fill"}' },
        {
          tabId: "custom-size",
          viewport: '{"_tag":"freeform","width":1280,"height":801}',
        },
        {
          tabId: "explicit-preset",
          viewport: '{"_tag":"preset","presetId":"laptop-1280x800","width":1280,"height":800}',
        },
      ]);
    }),
  );
});
