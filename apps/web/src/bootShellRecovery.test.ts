import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import indexHtml from "../index.html?raw";

const RETRY_STORAGE_KEY = "solla:boot-recovery:v1";

/** The startup splash script from index.html, run against a minimal fake page. */
const splashScript = (() => {
  const scripts = [...indexHtml.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]!);
  const script = scripts.find((source) => source.includes("__sollaSplash"));
  if (!script) throw new Error("index.html has no startup splash script");
  return script;
})();

interface FakeElement {
  id?: string;
  type?: string;
  textContent?: string;
  disabled?: boolean;
  removed: boolean;
  style: { width?: string };
  classes: Set<string>;
  children: FakeElement[];
  listeners: Map<string, () => void>;
  classList: { add: (name: string) => void; contains: (name: string) => boolean };
  append: (...nodes: FakeElement[]) => void;
  remove: () => void;
  addEventListener: (type: string, listener: () => void) => void;
}

function element(id?: string): FakeElement {
  const node: FakeElement = {
    ...(id === undefined ? {} : { id }),
    removed: false,
    style: {},
    classes: new Set(),
    children: [],
    listeners: new Map(),
    classList: {
      add: (name) => node.classes.add(name),
      contains: (name) => node.classes.has(name),
    },
    append: (...nodes) => {
      node.children.push(...nodes);
    },
    remove: () => {
      node.removed = true;
    },
    addEventListener: (type, listener) => {
      node.listeners.set(type, listener);
    },
  };
  return node;
}

interface SplashController {
  readonly setStage: (stage: string) => void;
  readonly done: () => void;
}

function startPage(input: { readonly storedAttempts?: string } = {}) {
  const storage = new Map<string, string>();
  if (input.storedAttempts !== undefined) storage.set(RETRY_STORAGE_KEY, input.storedAttempts);
  const elements = new Map(
    ["boot-shell", "boot-shell-card", "boot-shell-status", "boot-shell-progress-fill"].map(
      (id) => [id, element(id)] as const,
    ),
  );
  const replaced: string[] = [];
  const fakeWindow: {
    setTimeout: (handler: () => void, ms: number) => ReturnType<typeof setTimeout>;
    sessionStorage: Pick<Storage, "getItem" | "setItem" | "removeItem">;
    location: { href: string; replace: (url: string) => void; reload: () => void };
    history: { state: null; replaceState: () => void };
    __sollaSplash?: SplashController;
  } = {
    setTimeout: (handler, ms) => setTimeout(handler, ms),
    sessionStorage: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => void storage.set(key, value),
      removeItem: (key) => void storage.delete(key),
    },
    location: {
      href: "https://host.example.ts.net/thread",
      replace: (url) => replaced.push(url),
      reload: () => replaced.push("reload"),
    },
    history: { state: null, replaceState: () => undefined },
  };
  const fakeDocument = {
    getElementById: (id: string) => elements.get(id) ?? null,
    createElement: () => element(),
  };
  new Function("window", "document", splashScript)(fakeWindow, fakeDocument);

  const shell = elements.get("boot-shell")!;
  const card = elements.get("boot-shell-card")!;
  return {
    splash: fakeWindow.__sollaSplash!,
    replaced,
    storage,
    shell,
    status: () => elements.get("boot-shell-status")!.textContent,
    progress: () => elements.get("boot-shell-progress-fill")!.style.width,
    retryButton: () => card.children.find((child) => child.id === "boot-shell-retry"),
  };
}

describe("startup splash", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("is only the logo on a fast start, and leaves when the app says it is ready", () => {
    const page = startPage();
    page.splash.setStage("signing-in");
    page.splash.setStage("connecting");
    page.splash.done();
    expect(page.shell.classes.has("boot-shell-slow")).toBe(false);

    vi.advanceTimersByTime(200);
    expect(page.shell.removed).toBe(true);
    expect(page.replaced).toHaveLength(0);
  });

  it("names the step it is waiting for once startup is slow", () => {
    const page = startPage();
    expect(page.status()).toBe("Loading Solla Code…");
    vi.advanceTimersByTime(1_500);
    expect(page.shell.classes.has("boot-shell-slow")).toBe(true);

    page.splash.setStage("signing-in");
    expect(page.status()).toBe("Signing in…");
    page.splash.setStage("connecting");
    expect(page.status()).toBe("Loading your workspace…");
    expect(page.progress()).toBe("60%");

    // Steps only move forward.
    page.splash.setStage("signing-in");
    expect(page.status()).toBe("Loading your workspace…");
  });

  it("reloads once when the app's code never ran, recording where it stopped", () => {
    const page = startPage();
    vi.advanceTimersByTime(8_000);

    expect(page.replaced).toHaveLength(1);
    const url = new URL(page.replaced[0]!);
    expect(url.searchParams.get("solla_boot_retry")).not.toBeNull();
    expect(url.searchParams.get("solla_boot_stage")).toBe("loading");
    expect(page.storage.get(RETRY_STORAGE_KEY)).toBe("attempted");
  });

  it("never reloads on its own once the app's code is running", () => {
    // Reloading a slow load threw away the downloads still arriving; on a
    // weak connection after a release the page never finished loading.
    const page = startPage();
    page.splash.setStage("signing-in");
    vi.advanceTimersByTime(29_000);

    expect(page.replaced).toHaveLength(0);
    expect(page.retryButton()).toBeUndefined();
    expect(page.status()).toBe("Signing in…");
  });

  it("hands over to the app when the workspace keeps it waiting", () => {
    const page = startPage();
    page.splash.setStage("signing-in");
    page.splash.setStage("connecting");
    vi.advanceTimersByTime(20_200);

    expect(page.shell.removed).toBe(true);
  });

  it("offers Retry when a step never finishes", () => {
    const page = startPage();
    page.splash.setStage("signing-in");
    vi.advanceTimersByTime(30_000);

    const retry = page.retryButton()!;
    expect(page.status()).toBe("Signing in…");
    retry.listeners.get("click")!();
    expect(retry.textContent).toBe("Retrying…");
    expect(retry.disabled).toBe(true);
    expect(new URL(page.replaced[0]!).searchParams.get("solla_boot_stage")).toBe("signing-in");

    // A reload that stalls leaves the page up; the button comes back.
    vi.advanceTimersByTime(10_000);
    expect(retry.textContent).toBe("Retry");
    expect(retry.disabled).toBe(false);
  });

  it("says loading failed after its one automatic reload", () => {
    const page = startPage({ storedAttempts: "attempted" });
    vi.advanceTimersByTime(8_000);

    expect(page.replaced).toHaveLength(0);
    expect(page.status()).toBe("Solla Code did not finish loading.");
    expect(page.retryButton()).toBeDefined();
  });
});
