import { describe, expect, it } from "vite-plus/test";

import {
  providerSessionWriteIsNews,
  type ProviderSessionWriteFields,
} from "./providerSessionWrites.ts";

const running: ProviderSessionWriteFields = {
  status: "running",
  providerName: "claudeAgent",
  providerInstanceId: "claudeAgent",
  runtimeMode: "full-access",
  activeTurnId: "turn-1",
  lastError: null,
  failureKind: null,
};

describe("providerSessionWriteIsNews", () => {
  it("suppresses the heartbeat that only moves the timestamp", () => {
    // The whole point: `updatedAt` is not a field here, so two writes that
    // differ only by when they happened are the same write.
    expect(providerSessionWriteIsNews(running, { ...running })).toBe(false);
  });

  it("always writes the first session", () => {
    expect(providerSessionWriteIsNews(undefined, running)).toBe(true);
  });

  it("writes every field that a client would render differently", () => {
    const changes: ReadonlyArray<Partial<ProviderSessionWriteFields>> = [
      { status: "ready" },
      { providerName: "codex" },
      { providerInstanceId: "codex" },
      { runtimeMode: "approval-required" },
      { activeTurnId: "turn-2" },
      { activeTurnId: null },
      { lastError: "Provider session error" },
      { failureKind: "retryable-upstream" },
    ];
    for (const change of changes) {
      expect(
        providerSessionWriteIsNews(running, { ...running, ...change }),
        JSON.stringify(change),
      ).toBe(true);
    }
  });

  it("treats an absent optional and an explicit null as the same", () => {
    // The dispatch omits `providerInstanceId` entirely when the event has
    // none, so a strict compare would call every such write news forever.
    expect(
      providerSessionWriteIsNews(
        { ...running, providerInstanceId: undefined, lastError: undefined, failureKind: undefined },
        { ...running, providerInstanceId: undefined, lastError: null, failureKind: null },
      ),
    ).toBe(false);
  });

  it("notices an instance id being dropped", () => {
    expect(providerSessionWriteIsNews(running, { ...running, providerInstanceId: undefined })).toBe(
      true,
    );
  });
});
