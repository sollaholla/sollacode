import { VmAgent, VmAgentIcon, VmAgentId, VmAgentStatus } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { toPersistenceSqlError } from "../Errors.ts";
import { VmAgentStore, type VmAgentStoreShape } from "../Services/VmAgents.ts";

const ByIdRequest = Schema.Struct({ vmAgentId: VmAgentId });
const ByHandleRequest = Schema.Struct({ handle: Schema.String });
const ByNameLowerRequest = Schema.Struct({ nameLower: Schema.String });
const ByThreadIdRequest = Schema.Struct({ threadId: Schema.String });
const RenameRequest = Schema.Struct({
  vmAgentId: VmAgentId,
  name: Schema.String,
  updatedAt: Schema.String,
});
const RenameResult = Schema.Struct({ vmAgentId: VmAgentId });
const UpdateIconRequest = Schema.Struct({
  vmAgentId: VmAgentId,
  icon: Schema.NullOr(VmAgentIcon),
  updatedAt: Schema.String,
});

const UpdateVoiceRequest = Schema.Struct({
  vmAgentId: VmAgentId,
  voice: Schema.NullOr(Schema.String),
  updatedAt: Schema.String,
});

const UpdateStatusRequest = Schema.Struct({
  vmAgentId: VmAgentId,
  status: VmAgentStatus,
  updatedAt: Schema.String,
});

const makeVmAgentStore = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const insertRow = SqlSchema.void({
    Request: VmAgent,
    execute: (row) => sql`
      INSERT INTO vm_agents (
        vm_agent_id,
        name,
        name_lower,
        handle,
        purpose,
        icon,
        avatar_color_index,
        voice,
        vm_id,
        thread_id,
        status,
        control_mode,
        guest_ip,
        last_error,
        created_at,
        updated_at
      ) VALUES (
        ${row.vmAgentId},
        ${row.name},
        ${row.name.toLowerCase()},
        ${row.handle},
        ${row.purpose},
        ${row.icon},
        COALESCE(
          (
            SELECT ${row.avatarColor ?? null}
            WHERE NOT EXISTS (
              SELECT 1 FROM vm_agents WHERE avatar_color_index = ${row.avatarColor ?? null}
            )
          ),
          (
            SELECT CASE
              WHEN NOT EXISTS (SELECT 1 FROM vm_agents WHERE avatar_color_index = 0) THEN 0
              ELSE (
                SELECT MIN(taken.avatar_color_index) + 1
                FROM vm_agents AS taken
                WHERE taken.avatar_color_index IS NOT NULL
                  AND NOT EXISTS (
                    SELECT 1 FROM vm_agents AS next
                    WHERE next.avatar_color_index = taken.avatar_color_index + 1
                  )
              )
            END
          )
        ),
        ${row.voice ?? null},
        ${row.vmId},
        ${row.threadId},
        ${row.status},
        ${row.controlMode},
        ${row.guestIp},
        ${row.lastError},
        ${row.createdAt},
        ${row.updatedAt}
      )
    `,
  });

  const listRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: VmAgent,
    execute: () => sql`
      SELECT
        vm_agent_id AS "vmAgentId",
        name,
        handle,
        purpose,
        icon,
        avatar_color_index AS "avatarColor",
        voice,
        vm_id AS "vmId",
        thread_id AS "threadId",
        status,
        control_mode AS "controlMode",
        guest_ip AS "guestIp",
        last_error AS "lastError",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM vm_agents
      ORDER BY created_at ASC, vm_agent_id ASC
    `,
  });

  const getByIdRow = SqlSchema.findOneOption({
    Request: ByIdRequest,
    Result: VmAgent,
    execute: ({ vmAgentId }) => sql`
      SELECT
        vm_agent_id AS "vmAgentId",
        name,
        handle,
        purpose,
        icon,
        avatar_color_index AS "avatarColor",
        voice,
        vm_id AS "vmId",
        thread_id AS "threadId",
        status,
        control_mode AS "controlMode",
        guest_ip AS "guestIp",
        last_error AS "lastError",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM vm_agents
      WHERE vm_agent_id = ${vmAgentId}
    `,
  });

  const getByHandleRow = SqlSchema.findOneOption({
    Request: ByHandleRequest,
    Result: VmAgent,
    execute: ({ handle }) => sql`
      SELECT
        vm_agent_id AS "vmAgentId",
        name,
        handle,
        purpose,
        icon,
        avatar_color_index AS "avatarColor",
        voice,
        vm_id AS "vmId",
        thread_id AS "threadId",
        status,
        control_mode AS "controlMode",
        guest_ip AS "guestIp",
        last_error AS "lastError",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM vm_agents
      WHERE handle = ${handle}
    `,
  });

  const getByNameLowerRow = SqlSchema.findOneOption({
    Request: ByNameLowerRequest,
    Result: VmAgent,
    execute: ({ nameLower }) => sql`
      SELECT
        vm_agent_id AS "vmAgentId",
        name,
        handle,
        purpose,
        icon,
        avatar_color_index AS "avatarColor",
        voice,
        vm_id AS "vmId",
        thread_id AS "threadId",
        status,
        control_mode AS "controlMode",
        guest_ip AS "guestIp",
        last_error AS "lastError",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM vm_agents
      WHERE name_lower = ${nameLower}
    `,
  });

  const getByThreadIdRow = SqlSchema.findOneOption({
    Request: ByThreadIdRequest,
    Result: VmAgent,
    execute: ({ threadId }) => sql`
      SELECT
        vm_agent_id AS "vmAgentId",
        name,
        handle,
        purpose,
        icon,
        avatar_color_index AS "avatarColor",
        voice,
        vm_id AS "vmId",
        thread_id AS "threadId",
        status,
        control_mode AS "controlMode",
        guest_ip AS "guestIp",
        last_error AS "lastError",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM vm_agents
      WHERE thread_id = ${threadId}
    `,
  });

  const deleteRow = SqlSchema.void({
    Request: ByIdRequest,
    execute: ({ vmAgentId }) => sql`DELETE FROM vm_agents WHERE vm_agent_id = ${vmAgentId}`,
  });

  const renameRows = SqlSchema.findAll({
    Request: RenameRequest,
    Result: RenameResult,
    execute: ({ vmAgentId, name, updatedAt }) => sql`
      UPDATE vm_agents
      SET name = ${name}, name_lower = ${name.toLowerCase()}, updated_at = ${updatedAt}
      WHERE vm_agent_id = ${vmAgentId}
        AND NOT EXISTS (
          SELECT 1 FROM vm_agents AS other
          WHERE other.name_lower = ${name.toLowerCase()} AND other.vm_agent_id <> ${vmAgentId}
        )
      RETURNING vm_agent_id AS "vmAgentId"
    `,
  });

  const updateIconRow = SqlSchema.void({
    Request: UpdateIconRequest,
    execute: ({ vmAgentId, icon, updatedAt }) => sql`
      UPDATE vm_agents
      SET icon = ${icon}, updated_at = ${updatedAt}
      WHERE vm_agent_id = ${vmAgentId}
    `,
  });

  const updateVoiceRow = SqlSchema.void({
    Request: UpdateVoiceRequest,
    execute: ({ vmAgentId, voice, updatedAt }) => sql`
      UPDATE vm_agents
      SET voice = ${voice}, updated_at = ${updatedAt}
      WHERE vm_agent_id = ${vmAgentId}
    `,
  });

  const updateStatusRow = SqlSchema.void({
    Request: UpdateStatusRequest,
    execute: ({ vmAgentId, status, updatedAt }) => sql`
      UPDATE vm_agents
      SET status = ${status}, updated_at = ${updatedAt}
      WHERE vm_agent_id = ${vmAgentId}
    `,
  });

  const insert: VmAgentStoreShape["insert"] = (agent) =>
    insertRow(agent).pipe(Effect.mapError(toPersistenceSqlError("VmAgentStore.insert:query")));

  const list: VmAgentStoreShape["list"] = () =>
    listRows(undefined).pipe(Effect.mapError(toPersistenceSqlError("VmAgentStore.list:query")));

  const getById: VmAgentStoreShape["getById"] = (vmAgentId) =>
    getByIdRow({ vmAgentId }).pipe(
      Effect.mapError(toPersistenceSqlError("VmAgentStore.getById:query")),
    );

  const getByHandle: VmAgentStoreShape["getByHandle"] = (handle) =>
    getByHandleRow({ handle }).pipe(
      Effect.mapError(toPersistenceSqlError("VmAgentStore.getByHandle:query")),
    );

  const getByNameLower: VmAgentStoreShape["getByNameLower"] = (nameLower) =>
    getByNameLowerRow({ nameLower }).pipe(
      Effect.mapError(toPersistenceSqlError("VmAgentStore.getByNameLower:query")),
    );

  const getByThreadId: VmAgentStoreShape["getByThreadId"] = (threadId) =>
    getByThreadIdRow({ threadId }).pipe(
      Effect.mapError(toPersistenceSqlError("VmAgentStore.getByThreadId:query")),
    );

  const deleteById: VmAgentStoreShape["deleteById"] = (vmAgentId) =>
    deleteRow({ vmAgentId }).pipe(
      Effect.mapError(toPersistenceSqlError("VmAgentStore.deleteById:query")),
    );

  const rename: VmAgentStoreShape["rename"] = (input) =>
    renameRows(input).pipe(
      Effect.map((rows) => rows.length > 0),
      Effect.mapError(toPersistenceSqlError("VmAgentStore.rename:query")),
    );

  const updateIcon: VmAgentStoreShape["updateIcon"] = (input) =>
    updateIconRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("VmAgentStore.updateIcon:query")),
    );

  const updateVoice: VmAgentStoreShape["updateVoice"] = (input) =>
    updateVoiceRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("VmAgentStore.updateVoice:query")),
    );

  const updateStatus: VmAgentStoreShape["updateStatus"] = (input) =>
    updateStatusRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("VmAgentStore.updateStatus:query")),
    );

  return {
    insert,
    list,
    getById,
    getByHandle,
    getByNameLower,
    getByThreadId,
    deleteById,
    rename,
    updateIcon,
    updateVoice,
    updateStatus,
  } satisfies VmAgentStoreShape;
});

export const VmAgentStoreLive = Layer.effect(VmAgentStore, makeVmAgentStore);
