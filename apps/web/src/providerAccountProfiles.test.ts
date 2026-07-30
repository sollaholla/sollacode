import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  deriveProviderAccountProfileState,
  providerAccountSwitchDisabledReason,
} from "./providerAccountProfiles";

function makeProvider(input: {
  readonly instanceId: string;
  readonly driver?: string;
  readonly email?: string;
  readonly authStatus?: ServerProvider["auth"]["status"];
  readonly slashCommands?: ReadonlyArray<string>;
  readonly enabled?: boolean;
}): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(input.instanceId),
    driver: ProviderDriverKind.make(input.driver ?? "claudeAgent"),
    displayName: input.instanceId,
    enabled: input.enabled ?? true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: {
      status: input.authStatus ?? "authenticated",
      ...(input.email ? { email: input.email } : {}),
    },
    checkedAt: "2026-07-29T15:00:00.000Z",
    models: [],
    slashCommands: (input.slashCommands ?? []).map((name) => ({ name })),
    skills: [],
  };
}

describe("provider account profiles", () => {
  it("lists only authenticated profiles for the active provider driver", () => {
    const state = deriveProviderAccountProfileState(
      [
        makeProvider({ instanceId: "claude_personal", email: "personal@example.com" }),
        makeProvider({ instanceId: "claude_work", email: "work@example.com" }),
        makeProvider({
          instanceId: "claude_signed_out",
          authStatus: "unauthenticated",
        }),
        makeProvider({
          instanceId: "codex_work",
          driver: "codex",
          email: "codex@example.com",
        }),
      ],
      ProviderInstanceId.make("claude_personal"),
    );

    expect(state.profiles.map((profile) => profile.instanceId)).toEqual([
      "claude_personal",
      "claude_work",
    ]);
    expect(state.activeProfile?.accountLabel).toBe("personal@example.com");
  });

  it("partitions usage identities by provider account and shares one account across instances", () => {
    const state = deriveProviderAccountProfileState(
      [
        makeProvider({ instanceId: "claude_primary", email: "same@example.com" }),
        makeProvider({ instanceId: "claude_backup", email: "same@example.com" }),
        makeProvider({ instanceId: "claude_work", email: "work@example.com" }),
      ],
      ProviderInstanceId.make("claude_primary"),
    );

    expect(state.profiles[0]?.accountKey).toBe(state.profiles[1]?.accountKey);
    expect(state.profiles[0]?.accountKey).not.toBe(state.profiles[2]?.accountKey);
    expect(state.profiles[0]?.accountKey).toBe("claudeAgent:account:same@example.com");
  });

  it("offers provider-native /login only for configured signed-out profiles when advertised", () => {
    const supported = deriveProviderAccountProfileState(
      [
        makeProvider({
          instanceId: "claude_personal",
          email: "personal@example.com",
          slashCommands: ["login"],
        }),
        makeProvider({
          instanceId: "claude_work",
          authStatus: "unauthenticated",
        }),
      ],
      ProviderInstanceId.make("claude_personal"),
    );
    expect(supported.supportsNativeLogin).toBe(true);
    expect(supported.nativeLoginTargets).toEqual([
      { instanceId: "claude_work", displayName: "claude_work" },
    ]);

    const unsupported = deriveProviderAccountProfileState(
      [
        makeProvider({ instanceId: "codex", driver: "codex", email: "me@example.com" }),
        makeProvider({
          instanceId: "codex_work",
          driver: "codex",
          authStatus: "unauthenticated",
        }),
      ],
      ProviderInstanceId.make("codex"),
    );
    expect(unsupported.supportsNativeLogin).toBe(false);
    expect(unsupported.nativeLoginTargets).toEqual([]);
  });

  it("prohibits account changes during active or unresolved provider work", () => {
    expect(
      providerAccountSwitchDisabledReason({
        isRunning: true,
        isBusy: false,
        isConnecting: false,
        hasPendingInteraction: false,
        hasVoiceOperation: false,
      }),
    ).toContain("active turn");
    expect(
      providerAccountSwitchDisabledReason({
        isRunning: false,
        isBusy: false,
        isConnecting: false,
        hasPendingInteraction: true,
        hasVoiceOperation: false,
      }),
    ).toContain("approval");
    expect(
      providerAccountSwitchDisabledReason({
        isRunning: false,
        isBusy: false,
        isConnecting: false,
        hasPendingInteraction: false,
        hasVoiceOperation: false,
      }),
    ).toBeNull();
  });
});
