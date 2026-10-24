import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as DesktopLifecycle from "../../app/DesktopLifecycle.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

/**
 * Settings → Storage's "Restart now": a compaction scheduled for the next
 * start runs as this relaunch's backend starts. The replacement is an
 * ordinary launch even when this one was started by the app updater, which
 * defers compaction; the renderer can only ask once the backend is serving,
 * by which point the updater's health check has passed.
 */
export const relaunchForDatabaseCompaction = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.RELAUNCH_FOR_DATABASE_COMPACTION_CHANNEL,
  payload: Schema.Void,
  result: Schema.Void,
  handler: Effect.fn("desktop.databaseCompaction.relaunch")(function* () {
    const lifecycle = yield* DesktopLifecycle.DesktopLifecycle;
    yield* lifecycle.relaunch("database-compaction", { ordinaryLaunch: true });
  }),
});
