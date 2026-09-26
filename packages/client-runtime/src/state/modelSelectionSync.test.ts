import { describe, expect, it } from "vite-plus/test";
import { ProviderInstanceId } from "@t3tools/contracts";
import { PendingModelSelections } from "./modelSelectionSync.ts";

const codex = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6-astra" };
const deepseek = { instanceId: ProviderInstanceId.make("deepcode"), model: "deepseek-flash" };

describe("pending model selections", () => {
  it("keeps the last choice through earlier echoes and accepts later remote changes", () => {
    const pending = new PendingModelSelections();
    pending.set("host/thread", codex);
    pending.set("host/thread", deepseek);
    expect(pending.accept("host/thread", codex)).toBe(false);
    expect(pending.accept("host/thread", { ...deepseek })).toBe(true);
    expect(pending.accept("host/thread", codex)).toBe(true);
  });

  it("isolates threads and does not let an earlier failed write clear a newer choice", () => {
    const pending = new PendingModelSelections();
    pending.set("host/thread", codex);
    pending.set("host/thread", deepseek);
    pending.failed("host/thread", codex);
    expect(pending.accept("other/thread", codex)).toBe(true);
    expect(pending.accept("host/thread", codex)).toBe(false);
    pending.failed("host/thread", deepseek);
    expect(pending.accept("host/thread", codex)).toBe(true);
  });
});
