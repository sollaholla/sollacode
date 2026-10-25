import {
  WsRemoteControlHostMediaTicketRpc,
  WsRemoteControlHostReportPointerRpc,
  WsRemoteControlMediaTicketRpc,
} from "@t3tools/contracts";

export const BENCH_EXTRA_RPCS = [
  WsRemoteControlMediaTicketRpc,
  WsRemoteControlHostMediaTicketRpc,
  WsRemoteControlHostReportPointerRpc,
] as const;
