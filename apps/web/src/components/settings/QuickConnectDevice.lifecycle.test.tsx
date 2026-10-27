// @vitest-environment happy-dom
import { StrictMode, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import * as DateTime from "effect/DateTime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { AuthPairingCredentialResult } from "@t3tools/contracts";

const mocks = vi.hoisted(() => ({ create: vi.fn(), revoke: vi.fn() }));
vi.mock("../../environments/primary", () => ({
  createServerPairingCredential: mocks.create,
  revokeServerPairingLink: mocks.revoke,
}));
vi.mock("./RedactedSensitiveText", () => ({ confirmSensitiveReveal: () => true }));
import { QuickConnectDevice } from "./QuickConnectDevice";

let root: Root;
let container: HTMLDivElement;
let mounted: boolean;
const credential = (id = "first"): AuthPairingCredentialResult => ({
  id,
  credential: `secret-${id}`,
  expiresAt: DateTime.makeUnsafe(Date.now() + 300_000),
});
const click = async (label: string) => {
  const button = [...document.querySelectorAll("button")].find(
    (item) => item.textContent?.trim() === label,
  );
  expect(button, `Missing ${label}`).toBeDefined();
  await act(async () => button!.click());
};
beforeEach(async () => {
  vi.useFakeTimers();
  Object.defineProperty(Element.prototype, "getAnimations", {
    configurable: true,
    value: () => [],
  });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mocks.create.mockReset();
  mocks.revoke.mockReset().mockResolvedValue(undefined);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  mounted = true;
  await act(async () =>
    root.render(
      <StrictMode>
        <QuickConnectDevice pairingBaseUrl="http://127.0.0.1:9999" clientSessions={[]} />
      </StrictMode>,
    ),
  );
});
afterEach(async () => {
  if (mounted) await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("QuickConnectDevice link lifecycle", () => {
  it("replaces an expired QR with a clear recovery action", async () => {
    mocks.create.mockResolvedValueOnce(credential()).mockResolvedValueOnce(credential("second"));
    await click("Show QR code");
    expect(document.querySelector("textarea")?.value).toContain("secret-first");
    await act(async () => vi.advanceTimersByTimeAsync(300_000));
    expect(document.body.textContent).toContain("This connection link has expired");
    expect(document.querySelector("textarea")).toBeNull();
    expect(mocks.revoke).toHaveBeenCalledWith("first");
    await click("Create new link");
    expect(document.querySelector("textarea")?.value).toContain("secret-second");
  });

  it("revokes a link that arrives after the user closes the dialog", async () => {
    let resolve!: (result: AuthPairingCredentialResult) => void;
    mocks.create.mockReturnValueOnce(
      new Promise<AuthPairingCredentialResult>((done) => {
        resolve = done;
      }),
    );
    await click("Show QR code");
    await click("Cancel");
    await act(async () => resolve(credential()));
    expect(mocks.revoke).toHaveBeenCalledWith("first");
    expect(document.querySelector("textarea")).toBeNull();
  });

  it("revokes the pending response after unmount and does not replace a newer link", async () => {
    let resolve!: (result: AuthPairingCredentialResult) => void;
    mocks.create.mockReturnValueOnce(
      new Promise<AuthPairingCredentialResult>((done) => {
        resolve = done;
      }),
    );
    await click("Show QR code");
    await act(async () => root.unmount());
    mounted = false;
    await act(async () => resolve(credential()));
    expect(mocks.revoke).toHaveBeenCalledWith("first");
  });

  it("revokes the old link when a new one is requested", async () => {
    mocks.create.mockResolvedValueOnce(credential()).mockResolvedValueOnce(credential("second"));
    await click("Show QR code");
    await click("Create new link");
    expect(mocks.revoke).toHaveBeenCalledWith("first");
    expect(document.querySelector("textarea")?.value).toContain("secret-second");
    await act(async () => root.unmount());
    mounted = false;
    expect(mocks.revoke).toHaveBeenCalledWith("second");
  });
});
