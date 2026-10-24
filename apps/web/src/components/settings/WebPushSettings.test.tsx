// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { AsyncResult } from "effect/unstable/reactivity";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { WebPushSettings } from "./WebPushSettings";

const mocks = vi.hoisted(() => ({
  status: vi.fn(),
  subscribe: vi.fn(),
  unsubscribe: vi.fn(),
  test: vi.fn(),
  current: vi.fn(),
  enable: vi.fn(),
  flag: vi.fn(),
  unavailable: vi.fn(),
}));
vi.mock("../../state/environments", () => ({
  usePrimaryEnvironment: () => ({
    environmentId: "host",
    label: "MacBook",
    connection: { phase: "connected" },
  }),
}));
vi.mock("../../state/server", () => ({
  serverEnvironment: {
    webPushStatus: "status",
    webPushSubscribe: "subscribe",
    webPushUnsubscribe: "unsubscribe",
    webPushTest: "test",
  },
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (kind: "status" | "subscribe" | "unsubscribe" | "test") => mocks[kind],
}));
vi.mock("../../browser/webPush", () => ({
  browserPushUnavailableReason: mocks.unavailable,
  currentBrowserPushSubscription: mocks.current,
  enableBrowserPush: mocks.enable,
  setBrowserPushEnabled: mocks.flag,
}));
let root: ReturnType<typeof createRoot>;
let container: HTMLDivElement;
const browserSubscription = {
  endpoint: "https://web.push.apple.com/phone",
  toJSON: () => ({
    endpoint: "https://web.push.apple.com/phone",
    keys: { auth: "auth", p256dh: "key" },
  }),
  unsubscribe: vi.fn().mockResolvedValue(true),
};
let enabled: boolean;
const preferences = { agentAlerts: true, requests: true, includeDetails: false };
function button(label: string) {
  const found = [...container.querySelectorAll("button")].find(
    (item) => item.textContent === label,
  );
  if (!found) throw new Error(`Missing ${label}`);
  return found;
}
async function click(element: HTMLElement) {
  await act(async () => {
    element.click();
  });
}
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("isSecureContext", true);
  enabled = false;
  mocks.unavailable.mockReturnValue(null);
  mocks.status.mockImplementation(async () =>
    AsyncResult.success({ publicKey: "host-key", subscribed: enabled, preferences }),
  );
  mocks.current.mockResolvedValue(null);
  mocks.enable.mockImplementation(async () => {
    mocks.current.mockResolvedValue(browserSubscription);
    return browserSubscription;
  });
  mocks.subscribe.mockImplementation(async () => {
    enabled = true;
    return AsyncResult.success(undefined);
  });
  mocks.unsubscribe.mockImplementation(async () => {
    enabled = false;
    return AsyncResult.success(undefined);
  });
  mocks.test.mockResolvedValue(AsyncResult.success(undefined));
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(<WebPushSettings />));
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

it("only enables from a tap, sends a test, and can turn off and re-enable", async () => {
  expect(mocks.enable).not.toHaveBeenCalled();
  expect(mocks.subscribe).not.toHaveBeenCalled();
  await click(button("Enable notifications"));
  expect(mocks.enable).toHaveBeenCalledWith("host-key");
  expect(mocks.subscribe).toHaveBeenCalledWith({
    environmentId: "host",
    input: { subscription: browserSubscription.toJSON(), preferences },
  });
  expect(container.textContent).toContain("Notifications enabled");
  await click(button("Send test notification"));
  expect(mocks.test).toHaveBeenCalledWith({
    environmentId: "host",
    input: { endpoint: browserSubscription.endpoint },
  });
  expect(container.textContent).toContain("accepted by the push service");
  await click(button("Turn off"));
  expect(mocks.unsubscribe).toHaveBeenCalledOnce();
  expect(browserSubscription.unsubscribe).toHaveBeenCalledOnce();
  expect(container.textContent).toContain("Enable notifications");
  await click(button("Enable notifications"));
  expect(mocks.subscribe).toHaveBeenCalledTimes(2);
});
it("allows turning off even when system notification permission is now blocked", async () => {
  await click(button("Enable notifications"));
  mocks.unavailable.mockReturnValue("Notifications are blocked.");
  await act(async () => root.render(<WebPushSettings />));
  expect(button("Turn off").disabled).toBe(false);
  await click(button("Turn off"));
  expect(mocks.unsubscribe).toHaveBeenCalledOnce();
});
it("reports permission denial and leaves host delivery off", async () => {
  mocks.enable.mockRejectedValueOnce(new Error("Notification permission was not granted."));
  await click(button("Enable notifications"));
  expect(container.querySelector('[role="alert"]')?.textContent).toContain(
    "permission was not granted",
  );
  expect(mocks.subscribe).not.toHaveBeenCalled();
});

it("saves notification categories and explicit lock-screen detail consent", async () => {
  await click(button("Enable notifications"));
  const details = container.querySelector<HTMLElement>(
    '[role="switch"][aria-label="Show notification details"]',
  );
  expect(details).not.toBeNull();
  await click(details!);
  expect(mocks.subscribe).toHaveBeenLastCalledWith({
    environmentId: "host",
    input: {
      subscription: browserSubscription.toJSON(),
      preferences: { ...preferences, includeDetails: true },
    },
  });
});
