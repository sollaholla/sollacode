import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as DesktopMenuBar from "../../window/DesktopMenuBar.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

const MenuBarStatsSchema = Schema.Struct({
  working: Schema.Number,
  waiting: Schema.Number,
  paused: Schema.Number,
  chats: Schema.Array(
    Schema.Struct({
      environmentId: Schema.String,
      threadId: Schema.String,
      title: Schema.String,
      status: Schema.Literals(["working", "waiting", "paused"]),
    }),
  ),
});

export const publishMenuBarStats = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.MENU_BAR_PUBLISH_STATS_CHANNEL,
  payload: MenuBarStatsSchema,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.menuBar.publishStats")(function* (stats) {
    const menuBar = yield* DesktopMenuBar.DesktopMenuBar;
    yield* menuBar.publishStats(stats);
  }),
});
