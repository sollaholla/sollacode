import source from "../../public/web-push-worker.js?raw";
import * as NodeVM from "node:vm";
import { describe, expect, it, vi } from "vite-plus/test";

const origin = "https://my-host.ts.net";
function worker(windows: unknown[] = []) {
  const handlers = new Map<string, (event: unknown) => void>();
  const showNotification = vi.fn().mockResolvedValue(undefined);
  const openWindow = vi.fn().mockResolvedValue({});
  NodeVM.runInNewContext(source, {
    URL,
    self: {
      location: { origin },
      addEventListener: (kind: string, handler: (event: unknown) => void) =>
        handlers.set(kind, handler),
      registration: { showNotification },
      clients: { matchAll: async () => windows, openWindow },
    },
  });
  const dispatch = async (kind: string, event: object) => {
    let completion: Promise<unknown> | undefined;
    handlers.get(kind)?.({
      ...event,
      waitUntil: (value: Promise<unknown>) => {
        completion = value;
      },
    });
    await completion;
  };
  return { handlers, dispatch, showNotification, openWindow };
}

describe("push service worker", () => {
  it("displays incoming pushes even with no page open, without caching the app", async () => {
    const w = worker();
    await w.dispatch("push", {
      data: {
        json: () => ({
          title: "Approval needed",
          body: "Review this request",
          path: "/host/thread",
          tag: "request1",
        }),
      },
    });
    expect(w.showNotification).toHaveBeenCalledWith(
      "Approval needed",
      expect.objectContaining({
        body: "Review this request",
        data: { url: `${origin}/host/thread` },
        tag: "request1",
      }),
    );
    expect(w.handlers.has("fetch")).toBe(false);
  });
  it("always displays a fallback for malformed pushes and rejects external links", async () => {
    const w = worker();
    await w.dispatch("push", {
      data: {
        json: () => {
          throw new Error("bad json");
        },
      },
    });
    expect(w.showNotification).toHaveBeenCalledWith(
      "Solla Code",
      expect.objectContaining({ data: { url: `${origin}/` } }),
    );
    await w.dispatch("push", { data: { json: () => ({ path: "https://evil.test/path" }) } });
    expect(w.showNotification).toHaveBeenLastCalledWith(
      "Solla Code",
      expect.objectContaining({ data: { url: `${origin}/` } }),
    );
  });
  it("reuses an existing Solla window when the notification is tapped", async () => {
    const client = {
      url: `${origin}/`,
      navigate: vi.fn().mockResolvedValue({}),
      focus: vi.fn().mockResolvedValue({}),
    };
    const w = worker([client]);
    const close = vi.fn();
    await w.dispatch("notificationclick", {
      notification: { close, data: { url: `${origin}/agents/host/agent` } },
    });
    expect(close).toHaveBeenCalledOnce();
    expect(client.navigate).toHaveBeenCalledWith(`${origin}/agents/host/agent`);
    expect(client.focus).toHaveBeenCalledOnce();
    expect(w.openWindow).not.toHaveBeenCalled();
  });
  it("opens the target when no window exists or the previous window is closing", async () => {
    const w = worker([
      { url: `${origin}/`, navigate: vi.fn().mockRejectedValue(new Error("gone")) },
    ]);
    await w.dispatch("notificationclick", {
      notification: { close() {}, data: { url: `${origin}/host/thread` } },
    });
    expect(w.openWindow).toHaveBeenCalledWith(`${origin}/host/thread`);
  });
});
