import { describe, expect, it } from "vite-plus/test";

import { describeProviderModelAccess } from "./providerModelAccess.ts";
import type { ServerProvider } from "@t3tools/contracts";

function provider(overrides: Partial<ServerProvider> = {}): ServerProvider {
  return {
    instanceId: "i",
    driver: "muse",
    displayName: "Muse Code",
    enabled: true,
    installed: true,
    version: "1.1.1",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-09-11T00:00:00.000Z",
    availability: "available",
    models: [],
    slashCommands: [],
    skills: [],
    ...overrides,
  } as unknown as ServerProvider;
}

describe("describeProviderModelAccess", () => {
  it("sends a signed-in account with no plan to the plans page", () => {
    const notice = describeProviderModelAccess(
      provider({
        modelAccess: {
          state: "no-plan",
          detail: "This Meta account has no Muse plan, so it serves no models.",
          url: "https://accountscenter.meta.com/muse_code/",
        },
      }),
      { canSwitchAccount: true },
    );
    expect(notice?.title).toBe("No plan on this account");
    expect(notice?.action).toEqual({
      kind: "link",
      label: "View plans",
      href: "https://accountscenter.meta.com/muse_code/",
    });
  });

  it("offers a sign-in button for API-key and CLI providers alike", () => {
    const deepcode = describeProviderModelAccess(
      provider({
        driver: "deepcode" as ServerProvider["driver"],
        auth: { status: "unauthenticated" },
      }),
      { canSwitchAccount: true },
    );
    expect(deepcode?.action).toEqual({ kind: "switch-account", label: "Sign in" });

    // A CLI that owns its own browser login gets the same button. The app runs
    // the login for the person - either through the in-app account switch or
    // by running the command in a terminal pane - so there is no longer a
    // reason to name a command and send them elsewhere to type it.
    const muse = describeProviderModelAccess(
      provider({
        auth: { status: "unauthenticated", signInCommand: "muse login" },
      }),
      { canSwitchAccount: true },
    );
    expect(muse?.action).toEqual({ kind: "switch-account", label: "Sign in" });
  });

  it("never tells the person to run a command themselves", () => {
    // The regression this guards: the notice used to append
    // "Run `muse login` on the host", making the app's own sign-in an errand.
    const notice = describeProviderModelAccess(
      provider({ auth: { status: "unauthenticated", signInCommand: "muse login" } }),
      { canSwitchAccount: false },
    );
    expect(notice?.title).toBe("Not signed in");
    expect(notice?.detail).not.toContain("muse login");
    expect(notice?.detail).not.toMatch(/\brun\b/i);
    expect(notice?.detail).not.toMatch(/terminal/i);
  });

  it("says nothing when the provider is simply still probing", () => {
    // An empty list with no actionable cause must not accuse the person of
    // anything; the picker keeps its plain empty text.
    expect(describeProviderModelAccess(provider(), { canSwitchAccount: true })).toBeNull();
  });

  it("covers disabled and not-installed before auth", () => {
    expect(
      describeProviderModelAccess(provider({ enabled: false }), { canSwitchAccount: true })?.title,
    ).toBe("Provider disabled");
    expect(
      describeProviderModelAccess(provider({ installed: false }), { canSwitchAccount: true })
        ?.title,
    ).toBe("Not installed");
  });
});
