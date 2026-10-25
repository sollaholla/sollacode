import { describe, expect, it } from "vite-plus/test";
import { mediaChannelUrl } from "./mediaChannelSocket.ts";
describe("media channel URL", () => {
  it("keeps the remote origin and proxy prefix while dropping RPC credentials", () => {
    expect(
      mediaChannelUrl("wss://remote.example/solla/ws?wsTicket=secret#fragment", "one use"),
    ).toBe("wss://remote.example/solla/ws/media?ticket=one+use");
  });
  it("uses the local dev proxy's websocket prefix", () => {
    expect(mediaChannelUrl("ws://localhost:5173/ws", "ticket")).toBe(
      "ws://localhost:5173/ws/media?ticket=ticket",
    );
  });
});
