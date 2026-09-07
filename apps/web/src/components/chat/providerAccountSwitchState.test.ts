import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderAccountSwitchState,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { reconcileProviderAccountSwitch } from "./providerAccountSwitchState";

const state: ProviderAccountSwitchState = {
  id: "old-login",
  instanceId: ProviderInstanceId.make("codex"),
  driver: ProviderDriverKind.make("codex"),
  status: "waiting_for_authentication",
  startedAt: "2026-09-07T20:00:00.000Z",
  updatedAt: "2026-09-07T20:00:01.000Z",
  authUrl: null,
  previousAccountLabel: null,
  currentAccountLabel: null,
  message: null,
};

describe("account-switch response reconciliation", () => {
  it("releases a stale waiting panel when the host no longer has the login", () => {
    expect(reconcileProviderAccountSwitch(state, state.id, null)).toBeNull();
  });
  it("never reopens a dismissed panel when an outstanding poll completes", () => {
    expect(reconcileProviderAccountSwitch(null, state.id, state)).toBeNull();
  });
  it("does not let a cancelled old login clear a newer one", () => {
    const newer = { ...state, id: "new-login" };
    expect(reconcileProviderAccountSwitch(newer, state.id, null)).toBe(newer);
  });
  it("does not let an earlier poll revive a cancelled flow, even with equal timestamps", () => {
    const cancelled = { ...state, status: "cancelled" as const };
    expect(reconcileProviderAccountSwitch(cancelled, state.id, state)).toBe(cancelled);
  });
  it("accepts terminal cancellation and success replies", () => {
    for (const status of ["cancelled", "succeeded"] as const) {
      const finished = { ...state, status };
      expect(reconcileProviderAccountSwitch(state, state.id, finished)).toBe(finished);
    }
  });
  it("rejects another instance and older status replies", () => {
    expect(
      reconcileProviderAccountSwitch(state, state.id, {
        ...state,
        instanceId: ProviderInstanceId.make("codex-personal"),
      }),
    ).toBe(state);
    expect(
      reconcileProviderAccountSwitch(state, state.id, {
        ...state,
        updatedAt: state.startedAt,
      }),
    ).toBe(state);
  });
});
