/**
 * BrowserVmProvider - a real {@link VmProvider} backed by a headless Chromium.
 *
 * Each agent gets its own persistent browser context (a real Chrome/Chromium
 * launched via {@link https://playwright.dev playwright-core}) whose profile
 * directory lives under `vmsDir/<vmId>/profile`. That directory is the agent's
 * disk: cookies and logins survive `stop`/`start` and process restarts, exactly
 * as the plan's "one persistent machine per agent" bet requires. `capture`
 * returns a genuine page screenshot and `input` drives the page's real
 * mouse/keyboard, so the live view is the actual web the agent operates in — not
 * a synthetic mock frame.
 *
 * This is deliberately a *browser* environment rather than a full desktop VM: it
 * needs no hypervisor, boots in ~1s, and gives the agent a fully functioning web
 * surface today. A heavier {@link VmProvider} (e.g. Lume) can replace it behind
 * the same seam without touching the manager, RPC, or UI.
 */
import { type VmAgentInput, VmId, type VmPointerButton, VmProviderError } from "@t3tools/contracts";
// @effect-diagnostics nodeBuiltinImport:off - Manages the per-agent browser profile directory.
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { chromium, type BrowserContext, type Page } from "playwright-core";

import { ServerConfig } from "../config.ts";
import { VmProvider, type VmCapturedFrame, type VmProviderShape } from "./VmProvider.ts";

const VIEWPORT_WIDTH = 1280;
const VIEWPORT_HEIGHT = 800;
/** Where a freshly-provisioned agent lands: a real, unmistakably-live web page. */
const DEFAULT_START_URL = "https://www.google.com";
const NAVIGATION_TIMEOUT_MS = 30_000;

/**
 * System browser executables to fall back on when Playwright's own is absent.
 * Every platform's absolute paths live in one list: probing a Windows path on
 * macOS simply misses, so no host-platform lookup (and its lint constraint) is
 * needed to pick the right one.
 */
const SYSTEM_BROWSER_CANDIDATES: ReadonlyArray<string> = [
  // macOS
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
  // Linux
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/usr/bin/microsoft-edge",
  "/snap/bin/chromium",
  // Windows
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
];

/**
 * Find a launchable Chromium-family binary. Prefers Playwright's own managed
 * browser when it is actually installed, then falls back to a system browser.
 * Returns null when nothing usable is present.
 */
const resolveBrowserExecutable = (): string | null => {
  try {
    const bundled = chromium.executablePath();
    if (bundled && NodeFS.existsSync(bundled)) return bundled;
  } catch {
    // executablePath() throws when no managed browser is registered; fall through.
  }
  for (const candidate of SYSTEM_BROWSER_CANDIDATES) {
    if (NodeFS.existsSync(candidate)) return candidate;
  }
  return null;
};

const clamp01 = (value: number): number => (value < 0 ? 0 : value > 1 ? 1 : value);

const describeError = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

export interface BrowserVm {
  readonly context: BrowserContext;
  readonly page: Page;
  /** Last pointer position in frame pixels; the viewer overlays a cursor here. */
  cursor: { x: number; y: number };
  /**
   * Mouse buttons Chromium currently believes are held. Every press/release
   * flows through here so a dropped or duplicated edge can never strand the
   * button down — a stuck button turns every later click into a drag, which
   * silently breaks focusing inputs for the user *and* clicking for the agent.
   */
  readonly pressed: Set<VmPointerButton>;
  /**
   * Serializes page interactions. Each input event arrives as its own RPC (and
   * so its own fiber), and `applyInput` awaits between `mouse.move` and
   * `mouse.down`/`mouse.up`. Without this chain those steps interleave and a
   * click can be delivered as `move, move, up, down`, leaving the button held.
   */
  queue: Promise<unknown>;
}

/**
 * Run `operation` after every previously queued interaction for this VM.
 *
 * @internal Exported for tests: the ordering guarantee is the fix, and it is
 * only observable under concurrency.
 */
export const enqueue = <A>(vm: BrowserVm, operation: () => Promise<A>): Promise<A> => {
  // Failures must not poison the chain for later events, so the tail is always
  // a settled promise; the caller still observes its own rejection.
  const result = vm.queue.then(operation, operation);
  vm.queue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
};

/**
 * Apply one normalized input event to the live page.
 *
 * @internal Exported for tests alongside {@link enqueue}.
 */
export const applyInput = async (vm: BrowserVm, event: VmAgentInput): Promise<void> => {
  const { page } = vm;
  if (event.type === "pointer") {
    const x = clamp01(event.x) * (VIEWPORT_WIDTH - 1);
    const y = clamp01(event.y) * (VIEWPORT_HEIGHT - 1);
    vm.cursor = { x: Math.round(x), y: Math.round(y) };
    if (event.action === "move") {
      await page.mouse.move(x, y);
    } else if (event.action === "down") {
      await page.mouse.move(x, y);
      // A second press without an intervening release makes Chromium treat the
      // gesture as a drag and suppresses the click. Recover instead of wedging.
      if (vm.pressed.has(event.button)) {
        await page.mouse.up({ button: event.button }).catch(() => undefined);
        vm.pressed.delete(event.button);
      }
      await page.mouse.down({ button: event.button });
      vm.pressed.add(event.button);
    } else {
      await page.mouse.move(x, y);
      // A release with nothing held is a stray edge (pointer left the surface,
      // control flipped mid-gesture); forwarding it would confuse click state.
      if (!vm.pressed.has(event.button)) return;
      await page.mouse.up({ button: event.button });
      vm.pressed.delete(event.button);
    }
    return;
  }
  if (event.type === "scroll") {
    const x = clamp01(event.x) * (VIEWPORT_WIDTH - 1);
    const y = clamp01(event.y) * (VIEWPORT_HEIGHT - 1);
    vm.cursor = { x: Math.round(x), y: Math.round(y) };
    await page.mouse.move(x, y);
    await page.mouse.wheel(event.deltaX, event.deltaY);
    return;
  }
  if (event.type === "text") {
    await page.keyboard.type(event.text);
    return;
  }
  if (event.type === "press") {
    await page.keyboard.press(event.keys);
    return;
  }
  // Keyboard: the DOM `code` (e.g. "KeyA", "Enter", "ShiftLeft") maps directly
  // onto Playwright's key table and keeps modifier state correct; `key` is the
  // fallback when a synthetic event has no code.
  const key = event.code || event.key;
  if (!key) return;
  if (event.action === "down") {
    await page.keyboard.down(key);
  } else {
    await page.keyboard.up(key);
  }
};

const makeBrowserVmProvider = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const vms = new Map<string, BrowserVm>();
  // De-dupes concurrent launches (reconcile + a manual start can race).
  const launching = new Map<string, Promise<BrowserVm>>();

  const profileDir = (vmId: VmId): string => NodePath.join(config.vmsDir, vmId, "profile");

  const launch = async (vmId: VmId): Promise<BrowserVm> => {
    const executablePath = resolveBrowserExecutable();
    if (!executablePath) {
      throw new Error(
        "No Chrome/Chromium executable found. Install Google Chrome or run `npx playwright install chromium`.",
      );
    }
    const dir = profileDir(vmId);
    await NodeFSP.mkdir(dir, { recursive: true });
    const context = await chromium.launchPersistentContext(dir, {
      headless: true,
      executablePath,
      viewport: { width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT },
      args: [
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-blink-features=AutomationControlled",
      ],
    });
    const page = context.pages()[0] ?? (await context.newPage());
    const vm: BrowserVm = {
      context,
      page,
      cursor: { x: Math.round(VIEWPORT_WIDTH / 2), y: Math.round(VIEWPORT_HEIGHT / 2) },
      pressed: new Set<VmPointerButton>(),
      queue: Promise.resolve(),
    };
    // Navigate to the start page in the background so `start` resolves (and the
    // agent reports "running", and frames begin streaming) the moment the
    // browser is up, rather than blocking on a full page load. A failed
    // navigation (e.g. offline) still leaves a working blank browser to drive.
    void page
      .goto(DEFAULT_START_URL, { waitUntil: "domcontentloaded", timeout: NAVIGATION_TIMEOUT_MS })
      .catch(() => undefined);
    // If the browser dies on its own, drop it so the next start relaunches.
    context.on("close", () => {
      if (vms.get(vmId) === vm) vms.delete(vmId);
    });
    vms.set(vmId, vm);
    return vm;
  };

  const ensureVm = (vmId: VmId): Promise<BrowserVm> => {
    const existing = vms.get(vmId);
    if (existing) return Promise.resolve(existing);
    const inFlight = launching.get(vmId);
    if (inFlight) return inFlight;
    const started = launch(vmId).finally(() => launching.delete(vmId));
    launching.set(vmId, started);
    return started;
  };

  const closeVm = async (vmId: VmId): Promise<void> => {
    const vm = vms.get(vmId);
    if (!vm) return;
    vms.delete(vmId);
    await vm.context.close().catch(() => undefined);
  };

  // Close every live browser when the layer tears down (server shutdown).
  yield* Effect.addFinalizer(() =>
    Effect.promise(async () => {
      await Promise.all([...vms.keys()].map((vmId) => closeVm(vmId as VmId)));
    }),
  );

  const provider: VmProviderShape = {
    name: "browser",
    isAvailable: () => Effect.sync(() => resolveBrowserExecutable() !== null),
    create: ({ vmId }) =>
      Effect.tryPromise({
        try: () => NodeFSP.mkdir(profileDir(vmId), { recursive: true }).then(() => undefined),
        catch: (cause) =>
          new VmProviderError({ operation: "create", vmId, detail: describeError(cause) }),
      }),
    start: (vmId) =>
      Effect.tryPromise({
        try: () => ensureVm(vmId).then(() => ({ guestIp: null })),
        catch: (cause) =>
          new VmProviderError({ operation: "start", vmId, detail: describeError(cause) }),
      }),
    stop: (vmId) =>
      Effect.tryPromise({
        try: () => closeVm(vmId),
        catch: (cause) =>
          new VmProviderError({ operation: "stop", vmId, detail: describeError(cause) }),
      }),
    delete: (vmId) =>
      Effect.tryPromise({
        try: async () => {
          await closeVm(vmId);
          await NodeFSP.rm(NodePath.join(config.vmsDir, vmId), {
            recursive: true,
            force: true,
          }).catch(() => undefined);
        },
        catch: (cause) =>
          new VmProviderError({ operation: "delete", vmId, detail: describeError(cause) }),
      }),
    capture: (vmId) =>
      Effect.suspend(() => {
        const vm = vms.get(vmId);
        if (!vm) {
          return Effect.fail(
            new VmProviderError({ operation: "capture", vmId, detail: "VM is not running" }),
          );
        }
        return Effect.tryPromise({
          try: async (): Promise<VmCapturedFrame> => {
            const png = await vm.page.screenshot({ type: "png" });
            return {
              width: VIEWPORT_WIDTH,
              height: VIEWPORT_HEIGHT,
              format: "png",
              data: png.toString("base64"),
              cursor: { ...vm.cursor },
            };
          },
          catch: (cause) =>
            new VmProviderError({ operation: "capture", vmId, detail: describeError(cause) }),
        });
      }),
    input: (vmId, event) =>
      Effect.suspend(() => {
        const vm = vms.get(vmId);
        if (!vm) {
          return Effect.fail(
            new VmProviderError({ operation: "input", vmId, detail: "VM is not running" }),
          );
        }
        return Effect.tryPromise({
          // Queued, not called directly: concurrent RPCs must not interleave
          // the steps of a click (see BrowserVm.queue).
          try: () => enqueue(vm, () => applyInput(vm, event)),
          catch: (cause) =>
            new VmProviderError({ operation: "input", vmId, detail: describeError(cause) }),
        });
      }),
  };

  return provider;
});

export const VmProviderBrowserLive = Layer.effect(VmProvider, makeBrowserVmProvider);

/** Test/diagnostic hook: whether a launchable browser exists on this host. */
export const browserExecutableAvailable = (): boolean => resolveBrowserExecutable() !== null;
