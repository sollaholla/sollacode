// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  browserPushUnavailableReason,
  enableBrowserPush,
  isBrowserPushEnabled,
  setBrowserPushEnabled,
} from "./webPush";

const key = btoa("public-key").replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
const keyBuffer = new TextEncoder().encode("public-key").buffer;
const requestPermission = vi.fn();
const getSubscription = vi.fn();
const subscribe = vi.fn();
const register = vi.fn();
beforeEach(() => {
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  });
  vi.stubGlobal("isSecureContext", true);
  vi.stubGlobal("Notification", { permission: "default", requestPermission });
  vi.stubGlobal("PushManager", function () {});
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue("desktop");
  vi.spyOn(navigator, "platform", "get").mockReturnValue("Linux");
  Object.defineProperty(navigator, "serviceWorker", {
    configurable: true,
    value: {
      register,
      ready: Promise.resolve({ pushManager: { getSubscription, subscribe } }),
    },
  });
  requestPermission.mockResolvedValue("granted");
  register.mockResolvedValue({});
  getSubscription.mockResolvedValue(null);
  subscribe.mockResolvedValue({ endpoint: "test" });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("browser push registration", () => {
  it("asks for permission in the tap before any asynchronous registration", async () => {
    const result = enableBrowserPush(key);
    expect(requestPermission).toHaveBeenCalledOnce();
    expect(register).not.toHaveBeenCalled();
    await expect(result).resolves.toEqual({ endpoint: "test" });
    expect(register).toHaveBeenCalledWith("/web-push-worker.js", {
      scope: "/",
      updateViaCache: "none",
    });
    expect(subscribe).toHaveBeenCalledWith({
      userVisibleOnly: true,
      applicationServerKey: new Uint8Array(keyBuffer),
    });
  });
  it("does not register when permission is denied", async () => {
    requestPermission.mockResolvedValue("denied");
    await expect(enableBrowserPush(key)).rejects.toThrow("not granted");
    expect(register).not.toHaveBeenCalled();
  });
  it("reuses a subscription for the same host key", async () => {
    const existing = { options: { applicationServerKey: keyBuffer }, unsubscribe: vi.fn() };
    getSubscription.mockResolvedValue(existing);
    expect(await enableBrowserPush(key)).toBe(existing);
    expect(existing.unsubscribe).not.toHaveBeenCalled();
    expect(subscribe).not.toHaveBeenCalled();
  });
  it("replaces the subscription if the host key changed", async () => {
    const existing = {
      options: { applicationServerKey: new Uint8Array([1]).buffer },
      unsubscribe: vi.fn().mockResolvedValue(true),
    };
    getSubscription.mockResolvedValue(existing);
    await enableBrowserPush(key);
    expect(existing.unsubscribe).toHaveBeenCalledOnce();
    expect(subscribe).toHaveBeenCalledOnce();
  });
  it("explains HTTPS and iPhone Home Screen requirements", () => {
    vi.stubGlobal("isSecureContext", false);
    expect(browserPushUnavailableReason()).toContain("HTTPS");
    vi.stubGlobal("isSecureContext", true);
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue("iPhone");
    vi.spyOn(window, "matchMedia").mockReturnValue({ matches: false } as MediaQueryList);
    expect(browserPushUnavailableReason()).toContain("Add to Home Screen");
  });
  it("only suppresses duplicate foreground alerts for the enabled host", () => {
    vi.stubGlobal("Notification", { permission: "granted" });
    setBrowserPushEnabled("host", true);
    expect(isBrowserPushEnabled("host")).toBe(true);
    expect(isBrowserPushEnabled("other")).toBe(false);
    setBrowserPushEnabled("host", false);
    expect(isBrowserPushEnabled("host")).toBe(false);
  });
});
