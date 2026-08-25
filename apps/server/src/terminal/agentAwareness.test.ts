// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";

import { describe, expect, it } from "vite-plus/test";

import { T3_BROWSER_CONTROL_POLICY } from "../browserControlPolicy.ts";
import {
  CLAUDE_TERMINAL_MCP_CONFIG,
  GROK_TERMINAL_MCP_OVERLAY,
  injectTerminalAgentAwareness,
  POSIX_TERMINAL_AGENT_LAUNCHER,
  SOLLA_TERMINAL_AGENT_CONTEXT_ENV,
  SOLLA_TERMINAL_MCP_BEARER_TOKEN_ENV,
  SOLLA_TERMINAL_MCP_ENDPOINT_ENV,
  terminalAgentContext,
  WINDOWS_TERMINAL_AGENT_LAUNCHER,
  windowsTerminalAgentCommandLauncher,
} from "./agentAwareness.ts";

describe("terminal agent awareness", () => {
  it("injects private session context and prepends launchers without losing PATH", () => {
    const environment = injectTerminalAgentAwareness({
      environment: { PATH: "/usr/local/bin:/usr/bin", GROK_CONFIG: "/tmp/user-overlay.toml" },
      platform: "darwin",
      launcherDirectory: "/tmp/solla-agent-launchers",
      grokConfigPath: "/tmp/solla-agent-launchers/grok-config.toml",
      endpoint: "http://127.0.0.1:3773/mcp",
      bearerToken: "secret-terminal-token",
      threadId: "thread-1",
      terminalId: "term-2",
    });

    expect(environment.PATH).toBe("/tmp/solla-agent-launchers:/usr/local/bin:/usr/bin");
    expect(environment[SOLLA_TERMINAL_MCP_ENDPOINT_ENV]).toBe("http://127.0.0.1:3773/mcp");
    expect(environment[SOLLA_TERMINAL_MCP_BEARER_TOKEN_ENV]).toBe("secret-terminal-token");
    expect(environment[SOLLA_TERMINAL_AGENT_CONTEXT_ENV]).toContain(
      "attached to Solla thread thread-1 and terminal term-2",
    );
    expect(environment.GROK_CONFIG).toBeUndefined();
    expect(environment.GROK_CONFIG_PATH).toBe("/tmp/solla-agent-launchers/grok-config.toml");
  });

  it("keeps the provider launchers additive and leaves credentials out of generated files", () => {
    expect(POSIX_TERMINAL_AGENT_LAUNCHER).toContain("mcp_servers.t3-code.bearer_token_env_var");
    expect(POSIX_TERMINAL_AGENT_LAUNCHER).toContain("--append-system-prompt");
    expect(POSIX_TERMINAL_AGENT_LAUNCHER).toContain("--rules");
    expect(WINDOWS_TERMINAL_AGENT_LAUNCHER).toContain("--append-system-prompt");
    expect(WINDOWS_TERMINAL_AGENT_LAUNCHER).toContain('@("--mcp-config", $temporaryMcpConfig');
    expect(WINDOWS_TERMINAL_AGENT_LAUNCHER).toContain(
      "Remove-Item -LiteralPath $temporaryMcpConfig",
    );
    expect(WINDOWS_TERMINAL_AGENT_LAUNCHER).toContain(
      "Join-Path $shimDirectory $mcpConfigFileName",
    );
    expect(WINDOWS_TERMINAL_AGENT_LAUNCHER).not.toContain('@("--mcp-config", $mcpConfig');
    expect(windowsTerminalAgentCommandLauncher("grok")).toContain(
      'solla-agent-launch.ps1" grok %*',
    );
    expect(GROK_TERMINAL_MCP_OVERLAY).toContain("[mcp_servers.t3-code]");

    const generated = [
      POSIX_TERMINAL_AGENT_LAUNCHER,
      WINDOWS_TERMINAL_AGENT_LAUNCHER,
      CLAUDE_TERMINAL_MCP_CONFIG,
      GROK_TERMINAL_MCP_OVERLAY,
    ].join("\n");
    expect(generated).not.toContain("secret-terminal-token");
    expect(generated).toContain(`\${${SOLLA_TERMINAL_MCP_ENDPOINT_ENV}}`);
  });

  it("keeps Claude's generated MCP file valid and credential-free", () => {
    expect(JSON.parse(CLAUDE_TERMINAL_MCP_CONFIG)).toEqual({
      mcpServers: {
        "t3-code": {
          type: "http",
          url: `\${${SOLLA_TERMINAL_MCP_ENDPOINT_ENV}}`,
          headers: {
            Authorization: `Bearer \${${SOLLA_TERMINAL_MCP_BEARER_TOKEN_ENV}}`,
          },
        },
      },
    });
    expect(CLAUDE_TERMINAL_MCP_CONFIG).not.toContain("secret-terminal-token");
  });

  it("describes live Solla tools without hard-coding one provider's namespace", () => {
    const context = terminalAgentContext({ threadId: "thread-a", terminalId: "term-3" });
    expect(context).toContain("Solla Code's integrated terminal");
    expect(context).toContain("credential-bound t3-code MCP server");
    expect(context).toContain(T3_BROWSER_CONTROL_POLICY);
    expect(context).not.toContain("mcp__t3-code__");
  });

  it("executes the real CLI with provider-specific hidden arguments", () => {
    if (NodeProcess.platform === "win32") return;
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "solla-agent-awareness-"));
    try {
      const launchers = NodePath.join(root, "launchers");
      const realBin = NodePath.join(root, "real-bin");
      NodeFS.mkdirSync(launchers);
      NodeFS.mkdirSync(realBin);
      const fakeProvider = `#!/bin/sh
printf '%s\\0' "$@" > "$CAPTURE_FILE"
`;
      for (const provider of ["codex", "claude", "grok"] as const) {
        NodeFS.writeFileSync(NodePath.join(launchers, provider), POSIX_TERMINAL_AGENT_LAUNCHER, {
          mode: 0o700,
        });
        NodeFS.writeFileSync(NodePath.join(realBin, provider), fakeProvider, { mode: 0o700 });
        NodeFS.chmodSync(NodePath.join(launchers, provider), 0o700);
        NodeFS.chmodSync(NodePath.join(realBin, provider), 0o700);

        const captureFile = NodePath.join(root, `${provider}.args`);
        const result = NodeChildProcess.spawnSync(
          NodePath.join(launchers, provider),
          ["--resume", "session-1"],
          {
            env: {
              ...NodeProcess.env,
              PATH: `${launchers}:${realBin}:/usr/bin:/bin`,
              CAPTURE_FILE: captureFile,
              SOLLA_TERMINAL_MCP_ENDPOINT: "http://127.0.0.1:3773/mcp",
              SOLLA_TERMINAL_MCP_BEARER_TOKEN: "terminal-secret-token",
              SOLLA_TERMINAL_AGENT_CONTEXT: "hidden Solla terminal context",
            },
            encoding: "utf8",
          },
        );
        expect(result.status, result.stderr).toBe(0);
        const args = NodeFS.readFileSync(captureFile, "utf8").split("\0").filter(Boolean);
        expect(args.slice(-2)).toEqual(["--resume", "session-1"]);
        expect(args.join(" ")).not.toContain("terminal-secret-token");
        if (provider === "codex") {
          expect(args).toContain("mcp_servers.t3-code.url=http://127.0.0.1:3773/mcp");
        } else if (provider === "claude") {
          expect(args).toContain("--mcp-config");
          expect(args).toContain("--append-system-prompt");
          expect(args).toContain("hidden Solla terminal context");
        } else {
          expect(args.slice(0, 2)).toEqual(["--rules", "hidden Solla terminal context"]);
        }
      }
    } finally {
      NodeFS.rmSync(root, { recursive: true, force: true });
    }
  });

  it("passes Claude a temporary MCP file through PowerShell and removes it after exit", () => {
    const powershell = NodeProcess.platform === "win32" ? "powershell.exe" : "pwsh";
    const powershellProbe = NodeChildProcess.spawnSync(
      powershell,
      ["-NoProfile", "-Command", "exit 0"],
      { encoding: "utf8" },
    );
    if ((powershellProbe.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return;
    expect(powershellProbe.status, powershellProbe.stderr).toBe(0);

    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "solla-agent-awareness-win-"));
    try {
      const launchers = NodePath.join(root, "launchers");
      const realBin = NodePath.join(root, "real-bin");
      NodeFS.mkdirSync(launchers);
      NodeFS.mkdirSync(realBin);
      const launcherPath = NodePath.join(launchers, "solla-agent-launch.ps1");
      const fakeClaudePath = NodePath.join(realBin, "claude.ps1");
      const captureFile = NodePath.join(root, "claude-invocation.json");
      const pathSeparator = NodeProcess.platform === "win32" ? ";" : ":";
      const launcherSource =
        NodeProcess.platform === "win32"
          ? WINDOWS_TERMINAL_AGENT_LAUNCHER
          : WINDOWS_TERMINAL_AGENT_LAUNCHER.replace('-split ";"', '-split ":"').replace(
              '-join ";"',
              '-join ":"',
            );
      NodeFS.writeFileSync(launcherPath, launcherSource, "utf8");
      NodeFS.writeFileSync(
        fakeClaudePath,
        `param([Parameter(ValueFromRemainingArguments = $true)][string[]]$ForwardedArgs)
$configIndex = [Array]::IndexOf($ForwardedArgs, "--mcp-config")
$configPath = $ForwardedArgs[$configIndex + 1]
@{
  args = $ForwardedArgs
  configPath = $configPath
  config = [IO.File]::ReadAllText($configPath)
} | ConvertTo-Json -Compress | ForEach-Object {
  [IO.File]::WriteAllText($env:CAPTURE_FILE, $_, (New-Object System.Text.UTF8Encoding($false)))
}
`,
        "utf8",
      );

      const result = NodeChildProcess.spawnSync(
        powershell,
        [
          "-NoProfile",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          launcherPath,
          "claude",
          "--resume",
          "session-1",
        ],
        {
          env: {
            ...NodeProcess.env,
            PATH: `${launchers}${pathSeparator}${realBin}${pathSeparator}${NodeProcess.env.PATH ?? ""}`,
            CAPTURE_FILE: captureFile,
            SOLLA_TERMINAL_MCP_ENDPOINT: "http://127.0.0.1:3773/mcp",
            SOLLA_TERMINAL_MCP_BEARER_TOKEN: "terminal-secret-token",
            SOLLA_TERMINAL_AGENT_CONTEXT: "hidden Solla terminal context",
          },
          encoding: "utf8",
        },
      );
      expect(result.status, result.stderr).toBe(0);
      const captured = JSON.parse(NodeFS.readFileSync(captureFile, "utf8")) as {
        readonly args: string[];
        readonly configPath: string;
        readonly config: string;
      };
      expect(captured.args.slice(-2)).toEqual(["--resume", "session-1"]);
      expect(captured.config).toBe(CLAUDE_TERMINAL_MCP_CONFIG);
      expect(captured.config).not.toContain("terminal-secret-token");
      expect(NodeFS.existsSync(captured.configPath)).toBe(false);
    } finally {
      NodeFS.rmSync(root, { recursive: true, force: true });
    }
  });
});
