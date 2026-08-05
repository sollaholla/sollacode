import { describe, expect, it } from "vite-plus/test";

import { PreviewActivityConsumer, PreviewActivityLeases } from "./ActivityLeases.ts";

describe("PreviewActivityLeases", () => {
  it("keeps stable acquisitions idempotent", () => {
    const leases = new PreviewActivityLeases();

    expect(leases.acquire("tab-1", "ui:surface", PreviewActivityConsumer.Ui)).toBe(true);
    expect(leases.acquire("tab-1", "ui:surface", PreviewActivityConsumer.Ui)).toBe(false);
    expect(leases.snapshot("tab-1").total).toBe(1);

    expect(leases.release("tab-1", "ui:surface")).toBe(true);
    expect(leases.release("tab-1", "ui:surface")).toBe(false);
    expect(leases.snapshot("tab-1").total).toBe(0);
  });

  it("keeps independent consumers alive until their own lease ends", () => {
    const leases = new PreviewActivityLeases();
    leases.acquire("tab-1", "ui:surface", PreviewActivityConsumer.Ui);
    leases.acquire("tab-1", "automation:turn-1", PreviewActivityConsumer.Automation);
    leases.acquire("tab-1", "recording:active", PreviewActivityConsumer.Recording);
    leases.acquire("tab-1", "pip:active", PreviewActivityConsumer.PictureInPicture);

    leases.release("tab-1", "ui:surface");

    expect(leases.has("tab-1")).toBe(true);
    expect(leases.has("tab-1", PreviewActivityConsumer.Ui)).toBe(false);
    expect(leases.has("tab-1", PreviewActivityConsumer.Automation)).toBe(true);
    expect(leases.has("tab-1", PreviewActivityConsumer.Recording)).toBe(true);
    expect(leases.has("tab-1", PreviewActivityConsumer.PictureInPicture)).toBe(true);
    expect(leases.snapshot("tab-1").total).toBe(3);
  });

  it("summarizes consumers across tabs and clears one tab atomically", () => {
    const leases = new PreviewActivityLeases();
    leases.acquire("tab-1", "automation:a", PreviewActivityConsumer.Automation);
    leases.acquire("tab-1", "diagnostics:a", PreviewActivityConsumer.Diagnostics);
    leases.acquire("tab-2", "automation:b", PreviewActivityConsumer.Automation);

    const before = leases.snapshot();
    expect(before.total).toBe(3);
    expect(before.byConsumer.get(PreviewActivityConsumer.Automation)).toBe(2);
    expect(before.byConsumer.get(PreviewActivityConsumer.Diagnostics)).toBe(1);

    expect(leases.clearTab("tab-1")).toBe(2);
    expect(leases.has("tab-1")).toBe(false);
    expect(leases.snapshot().total).toBe(1);
  });

  it("rejects ambiguous lease-id reuse", () => {
    const leases = new PreviewActivityLeases();
    leases.acquire("tab-1", "active", PreviewActivityConsumer.Recording);

    expect(() =>
      leases.acquire("tab-1", "active", PreviewActivityConsumer.PictureInPicture),
    ).toThrow(/already owned by recording/);
  });
});
