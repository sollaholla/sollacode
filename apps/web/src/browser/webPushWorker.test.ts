import source from "../../public/web-push-worker.js?raw";
import * as NodeVM from "node:vm";
import { describe, expect, it, vi } from "vite-plus/test";

const origin = "https://my-host.ts.net";
function worker(windows: unknown[] = [], notifications?: ReadonlyArray<{ data?: unknown }>) {
  const handlers = new Map<string, (event: unknown) => void>();
  const showNotification = vi.fn().mockResolvedValue(undefined);
  const shown = { close: vi.fn() };
  const getNotifications = vi.fn().mockResolvedValue(notifications ?? [shown]);
  const openWindow = vi.fn().mockResolvedValue({});
  const timers: Array<{ readonly ms: number; readonly run: () => void }> = [];
  NodeVM.runInNewContext(source, {
    URL,
    // Recorded, and run only when a test says so.
    setTimeout: (run: () => void, ms: number) => {
      timers.push({ ms, run });
    },
    self: {
      location: { origin },
      addEventListener: (kind: string, handler: (event: unknown) => void) =>
        handlers.set(kind, handler),
      registration: { showNotification, getNotifications },
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
  return { handlers, dispatch, showNotification, getNotifications, shown, timers, openWindow };
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
  it("keeps an agent's call ringing until handled, and leaves other pushes quiet", async () => {
    const w = worker();
    await w.dispatch("push", {
      data: {
        json: () => ({
          kind: "call",
          title: "Nova is calling",
          body: "The deploy needs approval",
          path: "/call/host/call-1",
          tag: "call:call-1",
        }),
      },
    });
    expect(w.showNotification).toHaveBeenCalledWith(
      "Nova is calling",
      expect.objectContaining({
        tag: "call:call-1",
        requireInteraction: true,
        renotify: true,
        vibrate: [500, 250, 500, 250, 500, 250, 500],
        data: { url: `${origin}/call/host/call-1`, kind: "call" },
      }),
    );
    await w.dispatch("push", {
      data: { json: () => ({ title: "Approval needed", path: "/host/thread", tag: "request1" }) },
    });
    const [, options] = w.showNotification.mock.lastCall!;
    expect(options).not.toHaveProperty("requireInteraction");
    expect(options).not.toHaveProperty("vibrate");
  });
  it("replaces a stopped ring quietly under the same tag, then clears it after the push settles", async () => {
    const w = worker();
    await w.dispatch("push", {
      data: {
        json: () => ({
          kind: "call-ended",
          title: "Call with Nova answered",
          body: "Answered on iPhone",
          path: "/agents/host/agent-1",
          tag: "call:call-1",
        }),
      },
    });
    const [title, options] = w.showNotification.mock.lastCall!;
    expect(title).toBe("Call with Nova answered");
    expect(options).toMatchObject({ tag: "call:call-1", silent: true });
    expect(options).not.toHaveProperty("requireInteraction");
    expect(options).not.toHaveProperty("renotify");
    expect(options).not.toHaveProperty("vibrate");
    // The push event settles with the notice still on screen: browsers count
    // a push that leaves nothing up as silent.
    expect(w.getNotifications).not.toHaveBeenCalledWith({ tag: "call:call-1" });
    expect(w.shown.close).not.toHaveBeenCalled();
    expect(w.timers.map((timer) => timer.ms)).toEqual([4000]);
    w.timers[0]!.run();
    await vi.waitFor(() => expect(w.shown.close).toHaveBeenCalledOnce());
    expect(w.getNotifications).toHaveBeenCalledWith({ tag: "call:call-1" });
  });
  it("leaves every other notification up", async () => {
    const w = worker();
    await w.dispatch("push", {
      data: { json: () => ({ kind: "call", title: "Nova is calling", tag: "call:call-1" }) },
    });
    await w.dispatch("push", {
      data: { json: () => ({ title: "Approval needed", tag: "request1" }) },
    });
    expect(w.timers).toEqual([]);
    expect(w.shown.close).not.toHaveBeenCalled();
  });
  it("keeps a ring's kind and expiry, and clears rings stranded past it on the next push", async () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    const future = new Date(Date.now() + 60_000).toISOString();
    const stranded = { data: { kind: "call", expiresAt: past }, close: vi.fn() };
    const ringing = { data: { kind: "call", expiresAt: future }, close: vi.fn() };
    const missed = { data: { kind: "missed-call", expiresAt: past }, close: vi.fn() };
    const older = { data: { url: `${origin}/` }, close: vi.fn() };
    const w = worker([], [stranded, ringing, missed, older]);
    await w.dispatch("push", {
      data: {
        json: () => ({
          kind: "call",
          title: "Nova is calling",
          path: "/call/host/call-2",
          tag: "call:call-2",
          expiresAt: future,
        }),
      },
    });
    expect(w.showNotification).toHaveBeenCalledWith(
      "Nova is calling",
      expect.objectContaining({
        data: { url: `${origin}/call/host/call-2`, kind: "call", expiresAt: future },
      }),
    );
    expect(stranded.close).toHaveBeenCalledOnce();
    expect(ringing.close).not.toHaveBeenCalled();
    expect(missed.close).not.toHaveBeenCalled();
    expect(older.close).not.toHaveBeenCalled();
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
  it("asks an open Solla window to route itself when the notification is tapped, without reloading it", async () => {
    const client = {
      url: `${origin}/agents/host/other`,
      navigate: vi.fn().mockResolvedValue({}),
      postMessage: vi.fn(),
      focus: vi.fn().mockResolvedValue({}),
    };
    const w = worker([client]);
    const close = vi.fn();
    await w.dispatch("notificationclick", {
      notification: { close, data: { url: `${origin}/call/host/call-1` } },
    });
    expect(close).toHaveBeenCalledOnce();
    // Navigating would reload the page and drop a call in progress.
    expect(client.navigate).not.toHaveBeenCalled();
    expect(client.postMessage).toHaveBeenCalledWith({
      type: "solla-navigate",
      url: `${origin}/call/host/call-1`,
    });
    expect(client.focus).toHaveBeenCalledOnce();
    expect(w.openWindow).not.toHaveBeenCalled();
  });
  it("skips same-origin windows the server serves itself, which do not run the app", async () => {
    const file = {
      url: `${origin}/api/view/tmp/a.png`,
      postMessage: vi.fn(),
      focus: vi.fn().mockResolvedValue({}),
    };
    const app = {
      url: `${origin}/agents/host/other`,
      postMessage: vi.fn(),
      focus: vi.fn().mockResolvedValue({}),
    };
    const w = worker([file, app]);
    await w.dispatch("notificationclick", {
      notification: { close() {}, data: { url: `${origin}/call/host/call-1` } },
    });
    expect(file.postMessage).not.toHaveBeenCalled();
    expect(file.focus).not.toHaveBeenCalled();
    expect(app.postMessage).toHaveBeenCalledWith({
      type: "solla-navigate",
      url: `${origin}/call/host/call-1`,
    });
    expect(app.focus).toHaveBeenCalledOnce();
    expect(w.openWindow).not.toHaveBeenCalled();

    const alone = worker([file]);
    await alone.dispatch("notificationclick", {
      notification: { close() {}, data: { url: `${origin}/call/host/call-1` } },
    });
    expect(alone.openWindow).toHaveBeenCalledWith(`${origin}/call/host/call-1`);
  });
  it("opens the target when no window exists or the previous window is closing", async () => {
    const w = worker([
      {
        url: `${origin}/`,
        postMessage: vi.fn(),
        focus: vi.fn().mockRejectedValue(new Error("gone")),
      },
    ]);
    await w.dispatch("notificationclick", {
      notification: { close() {}, data: { url: `${origin}/host/thread` } },
    });
    expect(w.openWindow).toHaveBeenCalledWith(`${origin}/host/thread`);
  });
});
