import {
  WsPreviewAutomationConnectRpc,
  WsPreviewAutomationRespondRpc,
  WsPreviewRemoteFramesRpc,
  WsPreviewRemoteFramePublishRpc,
  WsPreviewRemoteInputRpc,
  WsPreviewRemoteSnapshotRpc,
  WsPreviewMediaWatchRpc,
  WsPreviewMediaTicketRpc,
  WsPreviewHostMediaTicketRpc,
  WsPreviewReportStatusRpc,
} from "@t3tools/contracts";
import { RpcGroup } from "effect/unstable/rpc";

/**
 * The slice of the environment's WebSocket API the remote preview uses, with
 * the production contracts. The bench server answers it with the production
 * broker and relay, so the wire traffic is the same as the app's.
 */
export const BenchRpcGroup = RpcGroup.make(
  WsPreviewAutomationConnectRpc,
  WsPreviewAutomationRespondRpc,
  WsPreviewRemoteSnapshotRpc,
  WsPreviewRemoteFramesRpc,
  WsPreviewRemoteFramePublishRpc,
  WsPreviewRemoteInputRpc,
  WsPreviewMediaWatchRpc,
  WsPreviewMediaTicketRpc,
  WsPreviewHostMediaTicketRpc,
  WsPreviewReportStatusRpc,
);
