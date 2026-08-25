import { T3_BROWSER_CONTROL_POLICY } from "../browserControlPolicy.ts";

export const SOLLA_TERMINAL_MCP_ENDPOINT_ENV = "SOLLA_TERMINAL_MCP_ENDPOINT";
export const SOLLA_TERMINAL_MCP_BEARER_TOKEN_ENV = "SOLLA_TERMINAL_MCP_BEARER_TOKEN";
export const SOLLA_TERMINAL_AGENT_CONTEXT_ENV = "SOLLA_TERMINAL_AGENT_CONTEXT";

export const CLAUDE_TERMINAL_MCP_CONFIG = `{"mcpServers":{"t3-code":{"type":"http","url":"\${SOLLA_TERMINAL_MCP_ENDPOINT}","headers":{"Authorization":"Bearer \${SOLLA_TERMINAL_MCP_BEARER_TOKEN}"}}}}`;

export const TERMINAL_AGENT_PROVIDERS = ["codex", "claude", "grok"] as const;
export type TerminalAgentProvider = (typeof TERMINAL_AGENT_PROVIDERS)[number];

export const POSIX_TERMINAL_AGENT_LAUNCHER = `#!/bin/sh
set -eu

provider=\${0##*/}
shim_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
original_path=\${PATH-}
filtered_path=
old_ifs=$IFS
IFS=:
for entry in $original_path; do
  [ -n "$entry" ] || entry=.
  resolved_entry=$(CDPATH= cd -- "$entry" 2>/dev/null && pwd -P || printf '%s' "$entry")
  [ "$resolved_entry" = "$shim_dir" ] && continue
  if [ -n "$filtered_path" ]; then
    filtered_path="$filtered_path:$entry"
  else
    filtered_path=$entry
  fi
done
IFS=$old_ifs
PATH=$filtered_path
export PATH
real_command=$(command -v "$provider" 2>/dev/null || true)
PATH=$original_path
export PATH

if [ -z "$real_command" ]; then
  printf 'Solla Code could not find the real %s executable outside its terminal launcher directory.\n' "$provider" >&2
  exit 127
fi

case "$provider" in
  codex)
    exec "$real_command" \
      -c "mcp_servers.t3-code.url=\${SOLLA_TERMINAL_MCP_ENDPOINT}" \
      -c 'mcp_servers.t3-code.bearer_token_env_var="SOLLA_TERMINAL_MCP_BEARER_TOKEN"' \
      "$@"
    ;;
  claude)
    claude_mcp_config='{"mcpServers":{"t3-code":{"type":"http","url":"\${SOLLA_TERMINAL_MCP_ENDPOINT}","headers":{"Authorization":"Bearer \${SOLLA_TERMINAL_MCP_BEARER_TOKEN}"}}}}'
    exec "$real_command" \
      --mcp-config "$claude_mcp_config" \
      --append-system-prompt "\${SOLLA_TERMINAL_AGENT_CONTEXT}" \
      "$@"
    ;;
  grok)
    exec "$real_command" --rules "\${SOLLA_TERMINAL_AGENT_CONTEXT}" "$@"
    ;;
  *)
    printf 'Unsupported Solla terminal agent launcher: %s\n' "$provider" >&2
    exit 64
    ;;
esac
`;

export const WINDOWS_TERMINAL_AGENT_LAUNCHER = `param(
  [Parameter(Mandatory = $true)][ValidateSet("codex", "claude", "grok")][string]$Provider,
  [Parameter(ValueFromRemainingArguments = $true)][string[]]$ForwardedArgs
)

$shimDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
$originalPath = $env:PATH
$filteredEntries = @($originalPath -split ";" | Where-Object {
  if ([string]::IsNullOrWhiteSpace($_)) { return $false }
  try { return [IO.Path]::GetFullPath($_) -ne [IO.Path]::GetFullPath($shimDirectory) }
  catch { return $_ -ne $shimDirectory }
})
$env:PATH = $filteredEntries -join ";"
$realCommand = Get-Command $Provider -CommandType Application, ExternalScript -ErrorAction SilentlyContinue | Select-Object -First 1
$env:PATH = $originalPath

if ($null -eq $realCommand) {
  [Console]::Error.WriteLine("Solla Code could not find the real $Provider executable outside its terminal launcher directory.")
  exit 127
}

$temporaryMcpConfig = $null
$injectedArgs = switch ($Provider) {
  "codex" {
    @(
      "-c", "mcp_servers.t3-code.url=$env:SOLLA_TERMINAL_MCP_ENDPOINT",
      "-c", 'mcp_servers.t3-code.bearer_token_env_var="SOLLA_TERMINAL_MCP_BEARER_TOKEN"'
    )
  }
  "claude" {
    # Windows PowerShell 5 strips the quotes from inline JSON when it builds a
    # native command line. Claude then mistakes the broken JSON for a relative
    # file path. A short-lived config file preserves the JSON exactly; its env
    # references are expanded by Claude, so no credential is written to disk.
    $mcpConfigFileName = "solla-claude-mcp-{0}.json" -f [guid]::NewGuid().ToString("N")
    $mcpConfigCandidates = @(
      (Join-Path ([IO.Path]::GetTempPath()) $mcpConfigFileName),
      (Join-Path $shimDirectory $mcpConfigFileName)
    )
    foreach ($candidate in $mcpConfigCandidates) {
      try {
        $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
        [IO.File]::WriteAllText($candidate, '${CLAUDE_TERMINAL_MCP_CONFIG}', $utf8NoBom)
        $temporaryMcpConfig = $candidate
        break
      }
      catch {}
    }
    if ($null -eq $temporaryMcpConfig) {
      [Console]::Error.WriteLine("Solla Code could not prepare Claude's private MCP configuration automatically. Restart Solla Code and try again.")
      exit 70
    }
    @("--mcp-config", $temporaryMcpConfig, "--append-system-prompt", $env:SOLLA_TERMINAL_AGENT_CONTEXT)
  }
  "grok" { @("--rules", $env:SOLLA_TERMINAL_AGENT_CONTEXT) }
}

$providerExitCode = 1
try {
  & $realCommand.Source @injectedArgs @ForwardedArgs
  $providerExitCode = $LASTEXITCODE
}
finally {
  if ($null -ne $temporaryMcpConfig) {
    Remove-Item -LiteralPath $temporaryMcpConfig -Force -ErrorAction SilentlyContinue
  }
}
exit $providerExitCode
`;

export function windowsTerminalAgentCommandLauncher(provider: TerminalAgentProvider): string {
  return `@echo off\r\npowershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0solla-agent-launch.ps1" ${provider} %*\r\nexit /b %ERRORLEVEL%\r\n`;
}

export const GROK_TERMINAL_MCP_OVERLAY = `[mcp_servers.t3-code]
url = "\${SOLLA_TERMINAL_MCP_ENDPOINT}"
headers = { Authorization = "Bearer \${SOLLA_TERMINAL_MCP_BEARER_TOKEN}" }
enabled = true
`;

export function terminalAgentContext(input: {
  readonly threadId: string;
  readonly terminalId: string;
}): string {
  return `You are running inside Solla Code's integrated terminal, attached to Solla thread ${input.threadId} and terminal ${input.terminalId}. Solla injects a credential-bound t3-code MCP server in memory. Use its collaboration and history tools for parent or sibling chats and persisted transcripts, its terminal tools for live panes, and its preview tools for attached browser surfaces. ${T3_BROWSER_CONTROL_POLICY} The server is not expected in filesystem MCP configuration; use the provider-qualified tool names your client exposes and query live state when needed.`;
}

function terminalPathKey(environment: NodeJS.ProcessEnv): string {
  return Object.keys(environment).find((key) => key.toUpperCase() === "PATH") ?? "PATH";
}

export function injectTerminalAgentAwareness(input: {
  readonly environment: NodeJS.ProcessEnv;
  readonly platform: NodeJS.Platform;
  readonly launcherDirectory: string;
  readonly grokConfigPath: string;
  readonly endpoint: string;
  readonly bearerToken: string;
  readonly threadId: string;
  readonly terminalId: string;
}): NodeJS.ProcessEnv {
  const environment = { ...input.environment };
  const pathKey = terminalPathKey(environment);
  const separator = input.platform === "win32" ? ";" : ":";
  const currentPath = environment[pathKey] ?? "";
  const pathEntries = currentPath.split(separator).filter((entry) => entry.length > 0);
  environment[pathKey] = [
    input.launcherDirectory,
    ...pathEntries.filter((entry) => entry !== input.launcherDirectory),
  ].join(separator);
  environment[SOLLA_TERMINAL_MCP_ENDPOINT_ENV] = input.endpoint;
  environment[SOLLA_TERMINAL_MCP_BEARER_TOKEN_ENV] = input.bearerToken;
  environment[SOLLA_TERMINAL_AGENT_CONTEXT_ENV] = terminalAgentContext(input);
  // Grok merges this environment overlay above its normal user and project
  // config layers, so the Solla server is session-only and user files remain
  // untouched. GROK_CONFIG is the older alias and must not shadow this path.
  delete environment.GROK_CONFIG;
  environment.GROK_CONFIG_PATH = input.grokConfigPath;
  return environment;
}
