import { describe, expect, it } from "vite-plus/test";

import { withProviderSignInCommand } from "./providerSignIn.ts";
import type { ServerProvider } from "@t3tools/contracts";

function provider(driver: string, auth: Partial<ServerProvider["auth"]> = {}): ServerProvider {
  return {
    instanceId: "instance",
    driver,
    displayName: driver,
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "unauthenticated", ...auth },
    checkedAt: "2026-09-11T00:00:00.000Z",
    availability: "available",
    models: [],
    slashCommands: [],
    skills: [],
  } as unknown as ServerProvider;
}

describe("withProviderSignInCommand", () => {
  it("names the command each CLI actually publishes", () => {
    expect(withProviderSignInCommand(provider("codex")).auth.signInCommand).toBe("codex login");
    expect(withProviderSignInCommand(provider("grok")).auth.signInCommand).toBe("grok login");
    expect(withProviderSignInCommand(provider("muse")).auth.signInCommand).toBe("muse login");
    // Claude's binary is not its driver kind, and its verb is `auth`.
    expect(withProviderSignInCommand(provider("claudeAgent")).auth.signInCommand).toBe(
      "claude auth",
    );
    expect(withProviderSignInCommand(provider("opencode")).auth.signInCommand).toBe(
      "opencode providers",
    );
  });

  it("offers nothing for a CLI with no login verb", () => {
    // Pasting a command that does not exist is worse than showing none: the
    // person cannot tell whether the app or the CLI is wrong.
    expect(withProviderSignInCommand(provider("antigravity")).auth.signInCommand).toBeUndefined();
    expect(withProviderSignInCommand(provider("mcpBridge")).auth.signInCommand).toBeUndefined();
    expect(withProviderSignInCommand(provider("deepcode")).auth.signInCommand).toBeUndefined();
  });

  it("keeps a command the driver set for its own configured binary", () => {
    const configured = provider("muse", { signInCommand: "/opt/muse/bin/muse login" });
    expect(withProviderSignInCommand(configured).auth.signInCommand).toBe(
      "/opt/muse/bin/muse login",
    );
  });
});
