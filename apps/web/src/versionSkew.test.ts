import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { APP_VERSION } from "./branding";
import {
  appendVersionMismatchHint,
  buildVersionMismatchDismissalKey,
  dismissVersionMismatch,
  isVersionMismatchDismissed,
  resolveServerConfigVersionMismatch,
  compareVersions,
  resolveServerSelfUpdateCapability,
  resolveVersionMismatch,
  resolveVersionSkewDirection,
  versionSkewGuidance,
  serverUpdateGuidance,
} from "./versionSkew";

describe("versionSkew", () => {
  it("does not warn when versions match", () => {
    expect(resolveVersionMismatch(APP_VERSION)).toBeNull();
  });

  it("returns a mismatch when the server version differs from the client", () => {
    expect(resolveVersionMismatch("9.9.9")).toEqual({
      clientVersion: APP_VERSION,
      serverVersion: "9.9.9",
      hint: "Version mismatch. Try syncing the client and server to the same Solla Code version.",
    });
  });

  it("reads the server version from config descriptors", () => {
    expect(
      resolveServerConfigVersionMismatch({
        environment: {
          environmentId: EnvironmentId.make("environment-1"),
          label: "Remote",
          platform: {
            os: "darwin",
            arch: "arm64",
          },
          serverVersion: "9.9.9",
          capabilities: {
            repositoryIdentity: true,
          },
        },
      }),
    ).toMatchObject({
      serverVersion: "9.9.9",
    });
  });

  it("keys dismissals by environment, client version, and server version", () => {
    const environmentId = EnvironmentId.make("environment-dismissal");
    const key = buildVersionMismatchDismissalKey(environmentId, {
      clientVersion: APP_VERSION,
      serverVersion: "9.9.9",
    });

    expect(key).toBe(`${environmentId}:${APP_VERSION}:9.9.9`);
    expect(isVersionMismatchDismissed(key)).toBe(false);

    dismissVersionMismatch(key);

    expect(isVersionMismatchDismissed(key)).toBe(true);
    expect(
      isVersionMismatchDismissed(
        buildVersionMismatchDismissalKey(environmentId, {
          clientVersion: APP_VERSION,
          serverVersion: "9.9.10",
        }),
      ),
    ).toBe(false);
  });

  it("appends a hint to connection errors when versions differ", () => {
    const mismatch = resolveVersionMismatch("9.9.9");

    expect(appendVersionMismatchHint("Socket closed.", mismatch)).toBe(
      "Socket closed. Hint: Version mismatch. Try syncing the client and server to the same Solla Code version.",
    );
  });

  it("reads desktop-managed update capabilities from config descriptors", () => {
    expect(
      resolveServerSelfUpdateCapability({
        environment: {
          environmentId: EnvironmentId.make("environment-desktop"),
          label: "Desktop",
          platform: { os: "darwin", arch: "arm64" },
          serverVersion: "9.9.9",
          capabilities: {
            repositoryIdentity: true,
            serverSelfUpdate: "desktop-managed",
          },
        },
      }),
    ).toBe("desktop-managed");
    expect(resolveServerSelfUpdateCapability(null)).toBeNull();
  });

  it("matches version-drift guidance to the advertised update path", () => {
    expect(serverUpdateGuidance("respawn", "Remote server")).toBe(
      "Update the Remote server so they stay in sync.",
    );
    expect(serverUpdateGuidance("desktop-managed", "Desktop server")).toBe(
      "The Desktop server is run by the Solla Code desktop app on its machine — update the desktop app there to sync them.",
    );
    expect(serverUpdateGuidance(null, "Local server")).toBe(
      "Relaunch the Local server with the copied command to sync them.",
    );
  });
});

describe("version skew direction", () => {
  it("compares versions numerically, not lexically", () => {
    // The case that motivated this: a 0.1.8 client on a 0.1.11 server. String
    // compare puts "0.1.11" before "0.1.8" and inverts the advice.
    expect(compareVersions("0.1.8", "0.1.11")).toBe(-1);
    expect(compareVersions("0.1.11", "0.1.8")).toBe(1);
    expect(compareVersions("0.1.11", "0.1.11")).toBe(0);
    expect(compareVersions("1.2.3", "1.2")).toBe(1);
    expect(compareVersions("1.2", "1.2.0")).toBe(0);
  });

  it("gives up on versions that are not plainly numeric", () => {
    expect(compareVersions("dev", "0.1.1")).toBeNull();
    expect(compareVersions("0.1.1", "")).toBeNull();
  });

  it("identifies which side is stale", () => {
    expect(resolveVersionSkewDirection({ clientVersion: "0.1.8", serverVersion: "0.1.11" })).toBe(
      "client-behind",
    );
    expect(resolveVersionSkewDirection({ clientVersion: "0.1.11", serverVersion: "0.1.8" })).toBe(
      "server-behind",
    );
    expect(resolveVersionSkewDirection({ clientVersion: "dev", serverVersion: "0.1.8" })).toBe(
      "unknown",
    );
  });

  it("tells a stale client to reload rather than to update the server", () => {
    // Telling someone on an older client to update a server that is already
    // ahead describes work that cannot clear the banner.
    const guidance = versionSkewGuidance({
      direction: "client-behind",
      capability: "desktop-managed",
      serverLabel: "Soloman's MacBook Pro server",
    });
    expect(guidance).toContain("Reload");
    expect(guidance).not.toContain("update the desktop app there");
  });

  it("keeps the server-update wording when the server is the stale side", () => {
    expect(
      versionSkewGuidance({
        direction: "server-behind",
        capability: "desktop-managed",
        serverLabel: "Soloman's MacBook Pro server",
      }),
    ).toContain("update the desktop app there");
    expect(
      versionSkewGuidance({
        direction: "unknown",
        capability: "boot-service",
        serverLabel: "server",
      }),
    ).toContain("Update the server");
  });
});
