import { describe, expect, it } from "vite-plus/test";

import {
  dynamicImportErrorFromEvent,
  installDynamicImportRecoveryListeners,
  isRecoverableDynamicImportEvent,
} from "./dynamicImportRecoveryListeners";

function eventWith(props: Record<string, unknown>): Event {
  return Object.assign(new Event("test"), props);
}

class FakeTarget {
  readonly handlers = new Map<string, Set<EventListener>>();
  addEventListener(name: string, handler: EventListener) {
    const set = this.handlers.get(name) ?? new Set();
    set.add(handler);
    this.handlers.set(name, set);
  }
  removeEventListener(name: string, handler: EventListener) {
    this.handlers.get(name)?.delete(handler);
  }
  dispatch(name: string, event: Event) {
    for (const handler of this.handlers.get(name) ?? []) handler(event);
  }
}

function harness(options: { desktop?: boolean; href?: string } = {}) {
  const target = new FakeTarget();
  const store = new Map<string, string>();
  const replaced: string[] = [];
  let reloads = 0;
  const results: string[] = [];
  const dispose = installDynamicImportRecoveryListeners({
    appVersion: "0.1.395",
    target: target as unknown as Window,
    getStorage: () =>
      ({
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, v),
      }) as unknown as Storage,
    location: {
      href: options.href ?? "https://solla.local/env/thread",
      pathname: "/env/thread",
      reload: () => {
        reloads += 1;
      },
      replace: (url) => void replaced.push(url),
    },
    now: () => 1_000_000,
    desktopBridgeAvailable: () => options.desktop ?? false,
    onRecovery: (r) => void results.push(r),
  });
  return { target, replaced, results, dispose, reloads: () => reloads };
}

const SAFARI = "Importing a module script failed.";

describe("dynamicImportErrorFromEvent", () => {
  it("reads Vite's preloadError payload", () => {
    expect(dynamicImportErrorFromEvent(eventWith({ payload: new Error(SAFARI) }))).toBeInstanceOf(
      Error,
    );
  });

  it("reads a rejection reason", () => {
    expect(dynamicImportErrorFromEvent(eventWith({ reason: SAFARI }))).toBe(SAFARI);
  });

  it("reads an error event's error", () => {
    expect(dynamicImportErrorFromEvent(eventWith({ error: SAFARI }))).toBe(SAFARI);
  });
});

describe("isRecoverableDynamicImportEvent", () => {
  // The exact string mobile Safari reported on 2026-09-03.
  it("recognises Safari's message", () => {
    expect(isRecoverableDynamicImportEvent(eventWith({ reason: new Error(SAFARI) }))).toBe(true);
  });

  it("recognises Chrome's message", () => {
    expect(
      isRecoverableDynamicImportEvent(
        eventWith({
          reason: new Error("Failed to fetch dynamically imported module: /assets/x.js"),
        }),
      ),
    ).toBe(true);
  });

  it("ignores an unrelated rejection", () => {
    expect(isRecoverableDynamicImportEvent(eventWith({ reason: new Error("boom") }))).toBe(false);
  });
});

describe("installDynamicImportRecoveryListeners", () => {
  // Previously escaped entirely: no boundary sits above these.
  it("recovers from an unhandled rejection", () => {
    const h = harness();
    h.target.dispatch("unhandledrejection", eventWith({ reason: new Error(SAFARI) }));
    expect(h.results).toEqual(["reloading"]);
    expect(h.replaced).toHaveLength(1);
  });

  it("recovers from Vite's preloadError", () => {
    const h = harness();
    h.target.dispatch("vite:preloadError", eventWith({ payload: new Error(SAFARI) }));
    expect(h.results).toEqual(["reloading"]);
  });

  it("leaves unrelated rejections alone", () => {
    const h = harness();
    h.target.dispatch("unhandledrejection", eventWith({ reason: new Error("boom") }));
    expect(h.results).toEqual([]);
    expect(h.replaced).toHaveLength(0);
  });

  // A reload loop would be worse than the original bug.
  it("reloads at most once, then stops", () => {
    const h = harness();
    h.target.dispatch("unhandledrejection", eventWith({ reason: new Error(SAFARI) }));
    h.target.dispatch("unhandledrejection", eventWith({ reason: new Error(SAFARI) }));
    expect(h.results).toEqual(["reloading", "already-attempted"]);
    expect(h.replaced).toHaveLength(1);
  });

  it("does not reload a document that just recovered and still carries a fresh marker", () => {
    const h = harness({ href: "https://solla.local/env/thread?solla_chunk_retry=999000" });
    h.target.dispatch("unhandledrejection", eventWith({ reason: new Error(SAFARI) }));
    expect(h.results).toEqual(["already-attempted"]);
    expect(h.replaced).toHaveLength(0);
  });

  // The marker outlives the release it recovered from: a phone parked on one
  // thread carries it into the next asset swap, which must still reload.
  it("reloads again when the retry marker is from an earlier recovery", () => {
    const h = harness({ href: "https://solla.local/env/thread?solla_chunk_retry=123" });
    h.target.dispatch("unhandledrejection", eventWith({ reason: new Error(SAFARI) }));
    expect(h.results).toEqual(["reloading"]);
    expect(h.replaced).toHaveLength(1);
    expect(new URL(h.replaced[0]!).searchParams.get("solla_chunk_retry")).toBe("1000000");
  });

  // Desktop keeps the visible error surface; its assets are local.
  it("does not auto-reload the desktop app", () => {
    const h = harness({ desktop: true });
    h.target.dispatch("unhandledrejection", eventWith({ reason: new Error(SAFARI) }));
    expect(h.results).toEqual([]);
  });

  it("stops listening once disposed", () => {
    const h = harness();
    h.dispose();
    h.target.dispatch("unhandledrejection", eventWith({ reason: new Error(SAFARI) }));
    expect(h.results).toEqual([]);
  });
});
