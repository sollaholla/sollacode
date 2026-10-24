import { describe, expect, it } from "vite-plus/test";
import { buildSettingsUpdatePrompt } from "@t3tools/shared/settingsPrompt";

import { resolveSettingsUpdates } from "./settingsUpdates.ts";

const message = {
  id: "settings-1",
  role: "user",
  text: buildSettingsUpdatePrompt("gpt-6-astra with high effort"),
  createdAt: "2026-10-01T22:29:00.149Z",
};
const receipt = {
  id: "applied-1",
  kind: "provider.handoff.completed",
  createdAt: message.createdAt,
  turnId: "turn-1",
};

describe("settings update completion", () => {
  it("keeps the original prompt pending until the host confirms it", () => {
    const pending = resolveSettingsUpdates([message], []);
    expect(pending.updates.get(message.id)?.completed).toBe(false);
    expect(pending.matchedActivityIds.size).toBe(0);
    const completed = resolveSettingsUpdates([message], [receipt]);
    expect(completed.updates.get(message.id)).toEqual({
      description: "gpt-6-astra with high effort",
      completed: true,
    });
    expect([...completed.matchedActivityIds]).toEqual([receipt.id]);
  });

  it("matches rapid settings changes individually even when receipts arrive out of order", () => {
    const second = { ...message, id: "settings-2", createdAt: "2026-10-01T22:29:04.555Z" };
    const result = resolveSettingsUpdates(
      [message, second],
      [
        {
          ...receipt,
          id: "applied-2",
          kind: "thread.settings.applied",
          createdAt: second.createdAt,
        },
      ],
    );
    expect(result.updates.get(message.id)?.completed).toBe(false);
    expect(result.updates.get(second.id)?.completed).toBe(true);
  });

  it("uses the turn identity for legacy receipts with a later timestamp", () => {
    const result = resolveSettingsUpdates(
      [{ ...message, turnId: receipt.turnId }],
      [{ ...receipt, createdAt: "2026-10-01T22:30:00Z" }],
    );
    expect(result.updates.get(message.id)?.completed).toBe(true);
  });

  it("leaves automatic transitions, unmatched receipts, and delegated messages visible", () => {
    for (const activity of [
      { ...receipt, kind: "provider.failover.completed" },
      { ...receipt, kind: "provider.failover.restored" },
      { ...receipt, createdAt: "2026-10-01T22:31:00Z" },
      { ...receipt, kind: "runtime.error" },
    ]) {
      const result = resolveSettingsUpdates([message], [activity]);
      expect(result.updates.get(message.id)?.completed).toBe(false);
      expect(result.matchedActivityIds.size).toBe(0);
    }
    expect(resolveSettingsUpdates([], [receipt]).matchedActivityIds.size).toBe(0);
    expect(
      resolveSettingsUpdates([{ ...message, senderThreadId: "another-thread" }], [receipt]).updates
        .size,
    ).toBe(0);
  });

  it("does not guess between ambiguous prompts or conflicting turns", () => {
    expect(
      resolveSettingsUpdates([message, { ...message, id: "duplicate" }], [receipt])
        .matchedActivityIds.size,
    ).toBe(0);
    expect(
      resolveSettingsUpdates([{ ...message, turnId: "other-turn" }], [receipt]).matchedActivityIds
        .size,
    ).toBe(0);
  });
});
