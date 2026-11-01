// @vitest-environment happy-dom
import * as Schema from "effect/Schema";
import { act, createElement, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { useLocalStorage } from "./useLocalStorage";

// The hook captures window.localStorage when it is imported, and Node's own
// global shadows happy-dom's, so the stand-in has to exist before that import.
const storage = vi.hoisted(() => {
  const stored = new Map<string, string>();
  const stub = {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => void stored.set(key, value),
    removeItem: (key: string) => void stored.delete(key),
    clear: () => stored.clear(),
  };
  vi.stubGlobal("localStorage", stub);
  return stub;
});

const KEY = "corrupt-key";
let root: Root;
let current: ReturnType<typeof useLocalStorage<number, number>>;

function Probe() {
  const result = useLocalStorage(KEY, 0, Schema.Number);
  useEffect(() => {
    current = result;
  });
  return null;
}

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(console, "error").mockImplementation(() => {});
  // Valid JSON that no longer matches the schema, as after a schema change.
  storage.setItem(KEY, JSON.stringify("not a number"));
  root = createRoot(document.createElement("div"));
  await act(() => root.render(createElement(Probe)));
});

afterEach(async () => {
  await act(() => root.unmount());
  storage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("useLocalStorage with a stored value that fails decode", () => {
  it("replaces it with a plain write", async () => {
    expect(current[0]).toBe(0);

    await act(() => current[1](42));

    expect(storage.getItem(KEY)).toBe("42");
    expect(current[0]).toBe(42);
  });

  it("runs an updater from the initial value", async () => {
    await act(() => current[1]((value) => value + 1));

    expect(storage.getItem(KEY)).toBe("1");
    expect(current[0]).toBe(1);
  });
});
