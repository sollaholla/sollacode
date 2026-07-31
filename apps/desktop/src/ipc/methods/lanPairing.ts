import {
  DesktopLanPairingCompletionInputSchema,
  DesktopLanPairingRequestInputSchema,
  DesktopLanPairingRequestResultSchema,
  DesktopLanDiscoveryStateSchema,
  DesktopLanPeerSchema,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as DesktopLanDiscovery from "../../network/DesktopLanDiscovery.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

export const listLanPeers = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.LIST_LAN_PEERS_CHANNEL,
  payload: Schema.Void,
  result: Schema.Array(DesktopLanPeerSchema),
  handler: Effect.fn("desktop.ipc.lanPairing.listPeers")(function* () {
    const discovery = yield* DesktopLanDiscovery.DesktopLanDiscovery;
    return yield* discovery.listPeers;
  }),
});

export const getLanDiscoveryState = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.GET_LAN_DISCOVERY_STATE_CHANNEL,
  payload: Schema.Void,
  result: DesktopLanDiscoveryStateSchema,
  handler: Effect.fn("desktop.ipc.lanPairing.getState")(function* () {
    const discovery = yield* DesktopLanDiscovery.DesktopLanDiscovery;
    return yield* discovery.getState;
  }),
});

export const requestLanPairing = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.REQUEST_LAN_PAIRING_CHANNEL,
  payload: DesktopLanPairingRequestInputSchema,
  result: DesktopLanPairingRequestResultSchema,
  handler: Effect.fn("desktop.ipc.lanPairing.request")(function* (input) {
    const discovery = yield* DesktopLanDiscovery.DesktopLanDiscovery;
    return yield* discovery.requestPairing(input);
  }),
});

export const completeLanPairing = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.COMPLETE_LAN_PAIRING_CHANNEL,
  payload: DesktopLanPairingCompletionInputSchema,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.lanPairing.complete")(function* (input) {
    const discovery = yield* DesktopLanDiscovery.DesktopLanDiscovery;
    yield* discovery.completePairing(input);
  }),
});
