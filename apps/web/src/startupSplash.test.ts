import { describe, expect, it } from "vite-plus/test";

import { startupRouteShowsChatView } from "./startupSplash";

describe("startupRouteShowsChatView", () => {
  it("waits for the chat view on conversation and landing pages", () => {
    expect(startupRouteShowsChatView("/")).toBe(true);
    expect(startupRouteShowsChatView("/env-1/thread-1")).toBe(true);
    expect(startupRouteShowsChatView("/draft/draft-1")).toBe(true);
  });

  it("does not wait for it where the first screen is something else", () => {
    expect(startupRouteShowsChatView("/settings")).toBe(false);
    expect(startupRouteShowsChatView("/settings/general")).toBe(false);
    expect(startupRouteShowsChatView("/agents/agent-1")).toBe(false);
    expect(startupRouteShowsChatView("/pair")).toBe(false);
    expect(startupRouteShowsChatView("/orchestrator")).toBe(false);
    // A thread whose id merely starts with a reserved word is still a thread.
    expect(startupRouteShowsChatView("/settings-env/thread-1")).toBe(true);
  });
});
