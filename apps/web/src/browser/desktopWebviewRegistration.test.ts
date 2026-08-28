import { describe, expect, it, vi } from "vite-plus/test";

import { createDesktopWebviewRegistrationCoordinator } from "./desktopWebviewRegistration";

describe("desktopWebviewRegistration", () => {
  it("serializes registration and lets only the latest owner publish retries", async () => {
    const coordinator = createDesktopWebviewRegistrationCoordinator();
    const calls: number[] = [];
    let releaseFirstRegistration: (() => void) | undefined;
    let observeSuccessorRegistration: (() => void) | undefined;
    let observePostReleaseRegistration: (() => void) | undefined;
    const firstRegistration = new Promise<void>((resolve) => {
      releaseFirstRegistration = resolve;
    });
    const successorRegistration = new Promise<void>((resolve) => {
      observeSuccessorRegistration = resolve;
    });
    const postReleaseRegistration = new Promise<void>((resolve) => {
      observePostReleaseRegistration = resolve;
    });
    const oldRegister = vi.fn(async (webContentsId: number) => {
      calls.push(webContentsId);
      await firstRegistration;
    });
    const successorRegister = vi.fn((webContentsId: number) => {
      calls.push(webContentsId);
      if (webContentsId === 43) observeSuccessorRegistration?.();
      if (webContentsId === 44) observePostReleaseRegistration?.();
    });

    const oldOwner = coordinator.acquire("tab_1", oldRegister);
    oldOwner.request(42);
    await Promise.resolve();
    expect(calls).toEqual([42]);

    const successorOwner = coordinator.acquire("tab_1", successorRegister);
    successorOwner.request(43);
    oldOwner.request(42);
    expect(calls).toEqual([42]);

    releaseFirstRegistration?.();
    await successorRegistration;
    expect(calls).toEqual([42, 43]);
    expect(oldRegister).toHaveBeenCalledExactlyOnceWith(42);
    expect(successorRegister).toHaveBeenCalledExactlyOnceWith(43);

    oldOwner.release();
    successorOwner.request(44);
    await postReleaseRegistration;
    expect(calls).toEqual([42, 43, 44]);

    successorOwner.release();
    successorOwner.request(45);
    await Promise.resolve();
    expect(calls).toEqual([42, 43, 44]);
  });
});
