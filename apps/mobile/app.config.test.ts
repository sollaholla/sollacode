import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const personalTeamEnvironmentKeys = [
  "T3CODE_IOS_PERSONAL_TEAM",
  "T3CODE_IOS_PERSONAL_TEAM_BUNDLE_ID",
] as const;

afterEach(() => {
  vi.unstubAllEnvs();
  for (const key of personalTeamEnvironmentKeys) {
    delete process.env[key];
  }
  vi.resetModules();
});

describe.sequential("mobile iOS build configuration", () => {
  it("keeps official production builds on the release team", async () => {
    vi.stubEnv("T3CODE_IOS_PERSONAL_TEAM", "0");
    const { default: config } = await import("./app.config.ts");

    expect(config.name).toBe("Solla Code");
    expect(config.ios?.bundleIdentifier).toBe("com.t3tools.t3code");
    expect(config.ios?.appleTeamId).toBe("ARK85ZXQ4Z");
    expect(config.ios?.infoPlist).toMatchObject({
      NSAppTransportSecurity: {
        NSAllowsArbitraryLoads: true,
      },
      NSLocalNetworkUsageDescription: expect.stringContaining("tailnet"),
    });
  });

  it("leaves Personal Team builds for user-owned Xcode signing", async () => {
    vi.stubEnv("T3CODE_IOS_PERSONAL_TEAM", "1");
    vi.stubEnv("T3CODE_IOS_PERSONAL_TEAM_BUNDLE_ID", "com.example.sollacode");
    const { default: config } = await import("./app.config.ts");

    expect(config.ios?.bundleIdentifier).toBe("com.example.sollacode");
    expect(config.ios?.appleTeamId).toBeUndefined();
    expect(config.extra).toMatchObject({ iosPersonalTeamBuild: true });
    expect(config.extra).not.toHaveProperty("relay");
    expect(config.plugins).not.toContain("./plugins/withShareExtensionDisplayName.cjs");
  });
});
