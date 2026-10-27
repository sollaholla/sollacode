import {
  defaultInstanceIdForDriver,
  ProviderDriverKind,
  type ServerProvider,
} from "@t3tools/contracts";
import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts/settings";
import { describe, expect, it } from "vite-plus/test";

import {
  buildProviderSetupEnablementPatch,
  defaultProviderSetupSelection,
  deriveProviderSetupNeed,
  deriveProviderSetupOptions,
  describeProviderSetupDetection,
} from "./providerSetup.logic";

const codex = ProviderDriverKind.make("codex");
const claude = ProviderDriverKind.make("claudeAgent");
const grok = ProviderDriverKind.make("grok");
const cursor = ProviderDriverKind.make("cursor");

function provider(driver: ProviderDriverKind, overrides: Partial<ServerProvider> = {}) {
  return {
    instanceId: defaultInstanceIdForDriver(driver),
    driver,
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-10-27T00:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    ...overrides,
  } as unknown as ServerProvider;
}

const pending = (driver: ProviderDriverKind) =>
  provider(driver, { installed: false, status: "warning", auth: { status: "unknown" } });

function options(providers: ServerProvider[], settings = DEFAULT_SERVER_SETTINGS) {
  return deriveProviderSetupOptions({ settings, providers });
}

function option(driver: ProviderDriverKind, providers: ServerProvider[]) {
  const found = options(providers).find((candidate) => candidate.driver === driver);
  if (!found) throw new Error(`missing ${driver}`);
  return found;
}

describe("provider setup", () => {
  it("lists built-in providers without the MCP bridge, and Cursor only when shipped", () => {
    const drivers = options([]).map((candidate) => candidate.driver);
    expect(drivers).toContain(codex);
    expect(drivers).not.toContain(ProviderDriverKind.make("mcpBridge"));
    expect(drivers).not.toContain(cursor);
    expect(options([provider(cursor)]).map((candidate) => candidate.driver)).toContain(cursor);
  });

  it("preselects only providers found on this computer", () => {
    const selection = defaultProviderSetupSelection(
      options([
        provider(codex),
        provider(claude, { auth: { status: "unauthenticated" } }),
        pending(grok),
      ]),
    );
    expect([...selection].toSorted()).toEqual([claude, codex].toSorted());
  });

  it("describes detection while the first check is still running", () => {
    expect(describeProviderSetupDetection(option(grok, [pending(grok)]))).toBe(
      "Checking this computer…",
    );
    expect(
      describeProviderSetupDetection(
        option(codex, [provider(codex, { auth: { status: "authenticated", email: "a@b.c" } })]),
      ),
    ).toBe("Signed in as a@b.c");
  });

  it("writes only the providers whose on/off state changes", () => {
    const all = options([provider(codex), provider(claude)]);
    const patch = buildProviderSetupEnablementPatch({
      settings: DEFAULT_SERVER_SETTINGS,
      options: all,
      selection: new Set(all.map((candidate) => candidate.driver).filter((d) => d !== claude)),
    });
    expect(Object.keys(patch?.providerInstances ?? {})).toEqual([
      defaultInstanceIdForDriver(claude),
    ]);
    expect(patch?.providerInstances?.[defaultInstanceIdForDriver(claude)]?.enabled).toBe(false);

    const unchanged = buildProviderSetupEnablementPatch({
      settings: DEFAULT_SERVER_SETTINGS,
      options: all,
      selection: new Set(all.filter((candidate) => candidate.enabled).map((c) => c.driver)),
    });
    expect(unchanged).toBeNull();
  });

  it("orders each provider's next step: install, then sign in, then ready", () => {
    expect(deriveProviderSetupNeed(option(grok, [pending(grok)]))).toEqual({ kind: "checking" });
    expect(
      deriveProviderSetupNeed(
        option(codex, [
          provider(codex, {
            installed: false,
            status: "error",
            auth: { status: "unknown" },
            versionAdvisory: {
              status: "unknown",
              currentVersion: null,
              latestVersion: null,
              updateCommand: null,
              canUpdate: false,
              installCommand: "npm i -g @openai/codex",
              canInstall: true,
              checkedAt: null,
              message: null,
            },
          }),
        ]),
      ),
    ).toEqual({
      kind: "install",
      canInstall: true,
      command: "npm i -g @openai/codex",
      error: null,
    });
    expect(
      deriveProviderSetupNeed(
        option(codex, [
          provider(codex, {
            installed: false,
            installState: {
              status: "running",
              startedAt: null,
              finishedAt: null,
              message: null,
              output: null,
            },
          }),
        ]),
      ),
    ).toEqual({ kind: "installing" });
    expect(
      deriveProviderSetupNeed(
        option(claude, [
          provider(claude, { auth: { status: "unauthenticated" }, supportsAccountSwitch: true }),
        ]),
      ),
    ).toEqual({ kind: "sign-in-in-app" });
    expect(
      deriveProviderSetupNeed(
        option(grok, [
          provider(grok, { auth: { status: "unauthenticated", signInCommand: "grok login" } }),
        ]),
      ),
    ).toEqual({ kind: "sign-in-terminal", command: "grok login" });
    expect(
      deriveProviderSetupNeed(
        option(codex, [provider(codex, { auth: { status: "authenticated", label: "Pro" } })]),
      ),
    ).toEqual({ kind: "ready", account: "Pro" });
  });
});
