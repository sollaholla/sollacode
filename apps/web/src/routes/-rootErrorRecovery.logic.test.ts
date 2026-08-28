import { describe, expect, it } from "vite-plus/test";

import {
  attemptDynamicImportRecovery,
  buildDynamicImportRecoveryUrl,
  DYNAMIC_IMPORT_RECOVERY_COOLDOWN_MS,
  dynamicImportRecoveryCleanupUrlAfterNavigation,
  dynamicImportRecoveryStorageKey,
  isDynamicImportFailure,
  shouldAutoRecoverDynamicImportFailure,
  stripDynamicImportRecoveryQuery,
} from "./-rootErrorRecovery.logic";

function createRecoveryHarness(input?: { readonly href?: string; readonly pathname?: string }) {
  const values = new Map<string, string>();
  const replacements: string[] = [];
  let reloads = 0;

  return {
    getStorage: () => ({
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value);
      },
    }),
    location: {
      href: input?.href ?? "https://solla.test/projects/example/threads/thread-1?panel=chat#turn",
      pathname: input?.pathname ?? "/projects/example/threads/thread-1",
      reload: () => {
        reloads += 1;
      },
      replace: (url: string) => {
        replacements.push(url);
      },
    },
    replacements,
    reloadCount: () => reloads,
    values,
  };
}

describe("root dynamic import recovery", () => {
  it.each([
    "Importing a module script failed.",
    "Failed to fetch dynamically imported module: https://solla.test/assets/old.js",
    "error loading dynamically imported module: https://solla.test/assets/old.js",
    "ChunkLoadError: Loading chunk 42 failed.",
    "Unable to preload CSS for /assets/old.css",
  ])("recognizes browser chunk failures: %s", (message) => {
    expect(isDynamicImportFailure(new TypeError(message))).toBe(true);
  });

  it("reloads a stale route once with a cache-busting URL", () => {
    const harness = createRecoveryHarness();
    const input = {
      appVersion: "0.1.298",
      error: new TypeError("Importing a module script failed."),
      getStorage: harness.getStorage,
      location: harness.location,
      now: 123_456,
    };

    expect(attemptDynamicImportRecovery(input)).toBe("reloading");
    expect(attemptDynamicImportRecovery(input)).toBe("already-attempted");
    expect(harness.replacements).toHaveLength(1);
    expect(harness.reloadCount()).toBe(0);
    expect(
      harness.values.get(
        dynamicImportRecoveryStorageKey({
          appVersion: input.appVersion,
          pathname: input.location.pathname,
        }),
      ),
    ).toBe("123456");

    const recoveryUrl = new URL(harness.replacements[0]!);
    expect(recoveryUrl.searchParams.get("solla_chunk_retry")).toBe("123456");
    expect(recoveryUrl.searchParams.get("panel")).toBe("chat");
    expect(recoveryUrl.hash).toBe("#turn");
  });

  it("blocks another automatic reload while the timestamp is inside the cooldown", () => {
    const harness = createRecoveryHarness();
    const now = 1_000_000;
    const storageKey = dynamicImportRecoveryStorageKey({
      appVersion: "0.1.298",
      pathname: harness.location.pathname,
    });
    harness.values.set(storageKey, (now - DYNAMIC_IMPORT_RECOVERY_COOLDOWN_MS + 1).toString());

    expect(
      attemptDynamicImportRecovery({
        appVersion: "0.1.298",
        error: new TypeError("Importing a module script failed."),
        getStorage: harness.getStorage,
        location: harness.location,
        now,
      }),
    ).toBe("already-attempted");
    expect(harness.replacements).toHaveLength(0);
    expect(harness.values.get(storageKey)).toBe(
      (now - DYNAMIC_IMPORT_RECOVERY_COOLDOWN_MS + 1).toString(),
    );
  });

  it("recovers again after the timestamp cooldown expires", () => {
    const harness = createRecoveryHarness();
    const now = 1_000_000;
    const storageKey = dynamicImportRecoveryStorageKey({
      appVersion: "0.1.298",
      pathname: harness.location.pathname,
    });
    harness.values.set(storageKey, (now - DYNAMIC_IMPORT_RECOVERY_COOLDOWN_MS).toString());

    expect(
      attemptDynamicImportRecovery({
        appVersion: "0.1.298",
        error: new TypeError("Importing a module script failed."),
        getStorage: harness.getStorage,
        location: harness.location,
        now,
      }),
    ).toBe("reloading");
    expect(harness.replacements).toHaveLength(1);
    expect(harness.values.get(storageKey)).toBe(now.toString());
  });

  it.each(["attempted", "", "NaN", "Infinity"])(
    "replaces a malformed recovery timestamp: %j",
    (storedValue) => {
      const harness = createRecoveryHarness();
      const now = 60_000;
      const storageKey = dynamicImportRecoveryStorageKey({
        appVersion: "0.1.298",
        pathname: harness.location.pathname,
      });
      harness.values.set(storageKey, storedValue);

      expect(
        attemptDynamicImportRecovery({
          appVersion: "0.1.298",
          error: new TypeError("Importing a module script failed."),
          getStorage: harness.getStorage,
          location: harness.location,
          now,
        }),
      ).toBe("reloading");
      expect(harness.values.get(storageKey)).toBe(now.toString());
    },
  );

  it("allows a new build or route to recover independently", () => {
    const harness = createRecoveryHarness();
    const error = new TypeError("Failed to fetch dynamically imported module");

    expect(
      attemptDynamicImportRecovery({
        appVersion: "0.1.298",
        error,
        getStorage: harness.getStorage,
        location: harness.location,
        now: 1,
      }),
    ).toBe("reloading");
    expect(
      attemptDynamicImportRecovery({
        appVersion: "0.1.299",
        error,
        getStorage: harness.getStorage,
        location: harness.location,
        now: 2,
      }),
    ).toBe("reloading");

    const otherRouteHarness = createRecoveryHarness({ pathname: "/settings" });
    expect(
      attemptDynamicImportRecovery({
        appVersion: "0.1.298",
        error,
        getStorage: harness.getStorage,
        location: otherRouteHarness.location,
        now: 3,
      }),
    ).toBe("reloading");
  });

  it("does not navigate for unrelated errors", () => {
    const unrelatedHarness = createRecoveryHarness();
    expect(
      attemptDynamicImportRecovery({
        appVersion: "0.1.298",
        error: new Error("Terminal session failed"),
        getStorage: unrelatedHarness.getStorage,
        location: unrelatedHarness.location,
        now: 1,
      }),
    ).toBe("ignored");
    expect(unrelatedHarness.replacements).toHaveLength(0);
  });

  it("keeps the URL guard through root mount when the session storage property getter throws", () => {
    const harness = createRecoveryHarness();
    const getStorage = () => {
      throw new Error("storage disabled");
    };
    const input = {
      appVersion: "0.1.298",
      error: "Importing a module script failed.",
      getStorage,
      location: harness.location,
      now: 1,
    };

    expect(attemptDynamicImportRecovery(input)).toBe("reloading");
    expect(harness.replacements).toHaveLength(1);
    expect(harness.reloadCount()).toBe(0);
    const recoveryUrl = new URL(harness.replacements[0]!);
    expect(recoveryUrl.pathname).toBe("/projects/example/threads/thread-1");
    expect(recoveryUrl.searchParams.get("panel")).toBe("chat");
    expect(recoveryUrl.hash).toBe("#turn");

    // RootRouteView has mounted, but the nested route can still be importing.
    // The shell must not remove the fallback guard until a later navigation.
    expect(
      dynamicImportRecoveryCleanupUrlAfterNavigation({
        href: harness.replacements[0]!,
        initialPathname: harness.location.pathname,
        currentPathname: harness.location.pathname,
      }),
    ).toBeNull();

    expect(
      attemptDynamicImportRecovery({
        ...input,
        location: { ...harness.location, href: harness.replacements[0]! },
        now: 2,
      }),
    ).toBe("already-attempted");
    expect(harness.replacements).toHaveLength(1);
  });

  it("cleans the recovery marker after a later pathname navigation", () => {
    expect(
      dynamicImportRecoveryCleanupUrlAfterNavigation({
        href: "https://solla.test/thread/2?panel=chat&solla_chunk_retry=42#turn",
        initialPathname: "/thread/1",
        currentPathname: "/thread/2",
      }),
    ).toBe("https://solla.test/thread/2?panel=chat#turn");
  });

  it.each(["getItem", "setItem"] as const)(
    "uses a marked replacement when session storage %s throws",
    (method) => {
      const harness = createRecoveryHarness();
      expect(
        attemptDynamicImportRecovery({
          appVersion: "0.1.298",
          error: "Importing a module script failed.",
          getStorage: () => ({
            getItem: () => {
              if (method === "getItem") {
                throw new Error("storage read failed");
              }
              return null;
            },
            setItem: () => {
              if (method === "setItem") {
                throw new Error("storage write failed");
              }
            },
          }),
          location: harness.location,
          now: 1,
        }),
      ).toBe("reloading");
      expect(harness.replacements).toHaveLength(1);
      expect(harness.reloadCount()).toBe(0);
    },
  );

  it("does not fall back to an unmarked reload when both storage and replace are unavailable", () => {
    const harness = createRecoveryHarness();
    expect(
      attemptDynamicImportRecovery({
        appVersion: "0.1.298",
        error: "Importing a module script failed.",
        getStorage: () => {
          throw new Error("storage disabled");
        },
        location: {
          ...harness.location,
          replace: () => {
            throw new Error("replace unavailable");
          },
        },
        now: 1,
      }),
    ).toBe("storage-unavailable");
    expect(harness.replacements).toHaveLength(0);
    expect(harness.reloadCount()).toBe(0);
  });

  it("falls back to location.reload after persisting the cooldown marker", () => {
    const harness = createRecoveryHarness();
    const location = {
      ...harness.location,
      replace: () => {
        throw new Error("replace unavailable");
      },
    };

    expect(
      attemptDynamicImportRecovery({
        appVersion: "0.1.298",
        error: "Importing a module script failed.",
        getStorage: harness.getStorage,
        location,
        now: 42,
      }),
    ).toBe("reloading");
    expect(harness.reloadCount()).toBe(1);
    expect(
      harness.values.get(
        dynamicImportRecoveryStorageKey({
          appVersion: "0.1.298",
          pathname: location.pathname,
        }),
      ),
    ).toBe("42");
  });

  it("builds and removes only the dynamic-import recovery query", () => {
    const href = "https://solla.test/thread/1?existing=yes#turn";
    const recoveryUrl = buildDynamicImportRecoveryUrl(href, 42);
    expect(recoveryUrl).toBe("https://solla.test/thread/1?existing=yes&solla_chunk_retry=42#turn");
    expect(stripDynamicImportRecoveryQuery(recoveryUrl)).toBe(
      "https://solla.test/thread/1?existing=yes#turn",
    );
    expect(stripDynamicImportRecoveryQuery(href)).toBeNull();
  });

  it("keys the one-shot guard by build and path", () => {
    expect(
      dynamicImportRecoveryStorageKey({ appVersion: "0.1.298", pathname: "/threads/a" }),
    ).not.toBe(dynamicImportRecoveryStorageKey({ appVersion: "0.1.299", pathname: "/threads/a" }));
    expect(
      dynamicImportRecoveryStorageKey({ appVersion: "0.1.298", pathname: "/threads/a" }),
    ).not.toBe(dynamicImportRecoveryStorageKey({ appVersion: "0.1.298", pathname: "/threads/b" }));
  });

  it("auto-recovers browser route failures but leaves Electron preview guests mounted", () => {
    expect(
      shouldAutoRecoverDynamicImportFailure({
        dynamicImportFailure: true,
        desktopBridgeAvailable: false,
      }),
    ).toBe(true);
    expect(
      shouldAutoRecoverDynamicImportFailure({
        dynamicImportFailure: true,
        desktopBridgeAvailable: true,
      }),
    ).toBe(false);
    expect(
      shouldAutoRecoverDynamicImportFailure({
        dynamicImportFailure: false,
        desktopBridgeAvailable: false,
      }),
    ).toBe(false);
  });
});
