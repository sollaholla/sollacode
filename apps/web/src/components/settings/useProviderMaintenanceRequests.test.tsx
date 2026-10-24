// @vitest-environment happy-dom
import { ProviderDriverKind } from "@t3tools/contracts";
import { act, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";
import { useProviderMaintenanceRequests } from "./useProviderMaintenanceRequests";

function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((complete, fail) => {
    resolve = complete;
    reject = fail;
  });
  return { promise, resolve, reject };
}

it("starts batched requests exactly once and clears each pending driver on success or failure", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  const root = createRoot(container);
  const codex = ProviderDriverKind.make("codex");
  const opencode = ProviderDriverKind.make("opencode");
  const codexResult = deferred();
  const openCodeResult = deferred();
  const updateCodex = vi.fn(() => codexResult.promise);
  const updateOpenCode = vi.fn(() => openCodeResult.promise);
  const duplicate = vi.fn(async () => {});
  const retry = vi.fn(async () => {});
  const errors: unknown[] = [];
  let requests: Promise<void>[] = [];
  function Fixture() {
    const { pendingDrivers, run } = useProviderMaintenanceRequests();
    return (
      <>
        <button
          onClick={() => {
            requests = [
              run(codex, updateCodex),
              run(opencode, updateOpenCode).catch((error) => {
                errors.push(error);
              }),
              run(opencode, duplicate),
            ];
          }}
        >
          Update both
        </button>
        <button
          onClick={() => {
            requests = [run(opencode, retry)];
          }}
        >
          Retry
        </button>
        <output>{[...pendingDrivers].join(",")}</output>
      </>
    );
  }
  try {
    await act(async () =>
      root.render(
        <StrictMode>
          <Fixture />
        </StrictMode>,
      ),
    );
    await act(async () => container.querySelector("button")!.click());
    expect(updateCodex).toHaveBeenCalledOnce();
    expect(updateOpenCode).toHaveBeenCalledOnce();
    expect(duplicate).not.toHaveBeenCalled();
    expect(container.querySelector("output")!.textContent).toBe("codex,opencode");
    await act(async () => {
      codexResult.resolve();
      await requests[0];
    });
    expect(container.querySelector("output")!.textContent).toBe("opencode");
    const failure = new Error("Connection interrupted");
    await act(async () => {
      openCodeResult.reject(failure);
      await Promise.all(requests);
    });
    expect(errors).toEqual([failure]);
    expect(container.querySelector("output")!.textContent).toBe("");
    await act(async () => {
      container.querySelectorAll("button")[1]!.click();
      await Promise.all(requests);
    });
    expect(retry).toHaveBeenCalledOnce();
    expect(container.querySelector("output")!.textContent).toBe("");
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
});
