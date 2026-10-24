import { describe, expect, it, vi } from "vite-plus/test";
import { acknowledgeRemoteClick } from "./acknowledgeRemoteClick";

function deferred<A>() {
  let resolve!: (value: A) => void;
  const promise = new Promise<A>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

describe("native click acknowledgement", () => {
  it("does not acknowledge until native injection has completed", async () => {
    const native = deferred<{ delivered: boolean }>();
    const acknowledge = vi.fn().mockResolvedValue(undefined);
    const delivery = acknowledgeRemoteClick(() => native.promise, acknowledge);
    await Promise.resolve();
    expect(acknowledge).not.toHaveBeenCalled();
    native.resolve({ delivered: true });
    await delivery;
    expect(acknowledge).toHaveBeenCalledExactlyOnceWith(true);
  });
  it("reports blocked and disconnected native input as unapplied", async () => {
    const acknowledge = vi.fn().mockResolvedValue(undefined);
    await acknowledgeRemoteClick(
      async () => ({ delivered: false, blocked: "secure-input" }),
      acknowledge,
    );
    await acknowledgeRemoteClick(async () => ({ delivered: false }), acknowledge);
    await acknowledgeRemoteClick(async () => undefined, acknowledge);
    expect(acknowledge.mock.calls).toEqual([[false], [false], [false]]);
  });
  it("reports native errors as unapplied", async () => {
    const acknowledge = vi.fn().mockResolvedValue(undefined);
    await acknowledgeRemoteClick(
      () => Promise.reject(new Error("native helper unavailable")),
      acknowledge,
    );
    expect(acknowledge).toHaveBeenCalledExactlyOnceWith(false);
  });
});
