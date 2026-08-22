// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTimersPromises from "node:timers/promises";
import * as NodeURL from "node:url";

import { afterEach, describe, expect, it } from "vite-plus/test";

import { McpBridgeConnection } from "./McpBridgeConnection.ts";

const fixture = NodeURL.fileURLToPath(
  new URL("./fixtures/fakeProviderBridge.mjs", import.meta.url),
);
const tempDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "solla-mcp-bridge-"));
  tempDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    tempDirectories
      .splice(0)
      .map((directory) => NodeFSP.rm(directory, { recursive: true, force: true })),
  );
});

describe("McpBridgeConnection", () => {
  it("forwards literal argv, cwd, and environment through an owned stdio process", async () => {
    const cwd = await temporaryDirectory();
    const connection = new McpBridgeConnection({
      command: process.execPath,
      args: [fixture, "value with spaces", "*literal*", "$(never-run)"],
      cwd,
      env: { ...process.env, FAKE_BRIDGE_FORWARDED_ENV: "forwarded" },
    });
    try {
      const described = await connection.describe();
      expect(described.health.argv).toEqual(["value with spaces", "*literal*", "$(never-run)"]);
      expect(described.health.cwd).toBe(await NodeFSP.realpath(cwd));
      expect(described.health.forwardedEnvironment).toBe("forwarded");
      expect(connection.pid).toBeTypeOf("number");
    } finally {
      await connection.shutdown();
    }
  });

  it("bounds and redacts captured stderr", async () => {
    const secret = "sensitive-bridge-value";
    const connection = new McpBridgeConnection({
      command: process.execPath,
      args: [fixture],
      env: {
        ...process.env,
        FAKE_BRIDGE_STDERR: `${"x".repeat(40_000)}${secret}`,
      },
      sensitiveValues: [secret],
    });
    try {
      await connection.describe();
      expect(connection.stderr.length).toBeLessThanOrEqual(32 * 1024);
      expect(connection.stderr).toContain("[REDACTED]");
      expect(connection.stderr).not.toContain(secret);
    } finally {
      await connection.shutdown();
    }
  });

  it("fails clearly on an application-contract version mismatch", async () => {
    const connection = new McpBridgeConnection({
      command: process.execPath,
      args: [fixture],
      env: { ...process.env, FAKE_BRIDGE_PROTOCOL_VERSION: "solla.provider-bridge/2" },
    });
    try {
      await expect(connection.describe()).rejects.toThrow(/major-version mismatch/u);
    } finally {
      await connection.shutdown();
    }
  });

  it("does not restart a live child for a malformed application response", async () => {
    const connection = new McpBridgeConnection({
      command: process.execPath,
      args: [fixture],
      env: {
        ...process.env,
        FAKE_BRIDGE_MALFORMED_TOOL: "provider_bridge.sessions_list",
      },
    });
    try {
      await connection.describe();
      const pid = connection.pid;
      await expect(
        connection.call("provider_bridge.sessions_list", {
          protocolVersion: "solla.provider-bridge/1",
        }),
      ).rejects.toThrow(/major-version mismatch/u);
      expect(connection.pid).toBe(pid);
      await expect(connection.describe()).resolves.toMatchObject({
        provider: { id: "fake-bridge" },
      });
      expect(connection.pid).toBe(pid);
    } finally {
      await connection.shutdown();
    }
  });

  it("does not restart a live child for a JSON-RPC application error", async () => {
    const connection = new McpBridgeConnection({
      command: process.execPath,
      args: [fixture],
      env: {
        ...process.env,
        FAKE_BRIDGE_RPC_ERROR_TOOL: "provider_bridge.sessions_list",
      },
    });
    try {
      await connection.describe();
      const pid = connection.pid;
      await expect(
        connection.call("provider_bridge.sessions_list", {
          protocolVersion: "solla.provider-bridge/1",
        }),
      ).rejects.toThrow(/intentional tool error/u);
      expect(connection.pid).toBe(pid);
      await expect(connection.describe()).resolves.toMatchObject({
        provider: { id: "fake-bridge" },
      });
      expect(connection.pid).toBe(pid);
    } finally {
      await connection.shutdown();
    }
  });

  it("retires and restarts the owned child after an in-session process failure", async () => {
    const directory = await temporaryDirectory();
    const exitMarker = NodePath.join(directory, "exited");
    const connection = new McpBridgeConnection({
      command: process.execPath,
      args: [fixture],
      env: {
        ...process.env,
        FAKE_BRIDGE_EXIT_TOOL: "provider_bridge.sessions_list",
        FAKE_BRIDGE_EXIT_ONCE_MARKER: exitMarker,
      },
    });
    try {
      await connection.describe();
      const pid = connection.pid;
      await expect(
        connection.call("provider_bridge.sessions_list", {
          protocolVersion: "solla.provider-bridge/1",
        }),
      ).rejects.toThrow(/request failed/u);
      expect(connection.pid).toBeNull();
      await expect(connection.describe()).resolves.toMatchObject({
        provider: { id: "fake-bridge" },
      });
      expect(connection.pid).not.toBe(pid);
    } finally {
      await connection.shutdown();
    }
  });

  it("reconnects after the owned child exits between requests", async () => {
    const connection = new McpBridgeConnection({
      command: process.execPath,
      args: [fixture],
      env: { ...process.env },
    });
    try {
      await connection.describe();
      const firstPid = connection.pid;
      expect(firstPid).toBeTypeOf("number");

      process.kill(firstPid!, "SIGKILL");
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if (connection.pid === null) break;
        await NodeTimersPromises.setTimeout(10);
      }
      expect(connection.pid).toBeNull();

      await expect(connection.describe()).resolves.toMatchObject({
        provider: { id: "fake-bridge" },
      });
      expect(connection.pid).toBeTypeOf("number");
      expect(connection.pid).not.toBe(firstPid);
    } finally {
      await connection.shutdown();
    }
  });

  it("restarts only its child after failure with bounded backoff", async () => {
    const directory = await temporaryDirectory();
    const crashMarker = NodePath.join(directory, "crashed");
    const connection = new McpBridgeConnection({
      command: process.execPath,
      args: [fixture],
      env: { ...process.env, FAKE_BRIDGE_CRASH_ONCE_MARKER: crashMarker },
    });
    try {
      await expect(connection.describe()).rejects.toThrow(/initialize external/u);
      await expect(connection.describe()).resolves.toMatchObject({
        provider: { id: "fake-bridge" },
      });
    } finally {
      await connection.shutdown();
    }
  });

  it("invokes bridge shutdown before transport closure", async () => {
    const directory = await temporaryDirectory();
    const marker = NodePath.join(directory, "shutdown");
    const connection = new McpBridgeConnection({
      command: process.execPath,
      args: [fixture],
      env: { ...process.env, FAKE_BRIDGE_MARKER: marker },
    });
    await connection.describe();
    await connection.shutdown();
    await expect(NodeFSP.readFile(marker, "utf8")).resolves.toBe("shutdown\n");
    expect(connection.pid).toBeNull();
  });

  it("terminates only its owned child when graceful stdio closure does not exit", async () => {
    const connection = new McpBridgeConnection({
      command: process.execPath,
      args: [fixture],
      env: { ...process.env, FAKE_BRIDGE_KEEP_ALIVE: "1" },
    });
    await connection.describe();
    const pid = connection.pid;
    expect(pid).toBeTypeOf("number");
    await connection.shutdown();
    expect(connection.pid).toBeNull();
    expect(() => process.kill(pid!, 0)).toThrow();
  });
});
