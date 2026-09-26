type Environment = Record<string, string | undefined>;

/** Restore the durable API endpoint when a Solla process was launched by Claude. */
export function restoreInheritedClaudeEnvironment(env: Environment): void {
  const sessionProxy = env.T3CODE_CLAUDE_PROXY_BASE_URL;
  const inheritedEndpoint = env.ANTHROPIC_BASE_URL;
  if (sessionProxy && inheritedEndpoint === sessionProxy) {
    const upstream = env.T3CODE_CLAUDE_PROXY_UPSTREAM;
    if (upstream) env.ANTHROPIC_BASE_URL = upstream;
    else delete env.ANTHROPIC_BASE_URL;
  } else if (
    !sessionProxy &&
    env.CLAUDECODE === "1" &&
    env.CLAUDE_CODE_ENTRYPOINT === "sdk-cli" &&
    env.CLAUDE_AGENT_SDK_VERSION &&
    (env.T3CODE_DESKTOP_ROOT_PID || env.T3_MCP_BEARER_TOKEN) &&
    /^http:\/\/127\.0\.0\.1:\d+$/u.test(inheritedEndpoint ?? "")
  ) {
    // Releases through 0.1.432 did not tag their per-session proxy. This
    // specific SDK + Solla ancestry repairs those installs on the next launch.
    // Explicit provider overrides are applied after this inherited env cleanup.
    delete env.ANTHROPIC_BASE_URL;
  }
  if (sessionProxy) delete env[ASSUME_FIRST_PARTY_ENDPOINT];
  delete env.T3CODE_CLAUDE_PROXY_BASE_URL;
  delete env.T3CODE_CLAUDE_PROXY_UPSTREAM;
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_ENTRYPOINT;
  delete env.CLAUDE_AGENT_SDK_VERSION;
}

// Claude Code treats any ANTHROPIC_BASE_URL other than api.anthropic.com as a
// third-party gateway: it caps models without a [1m] id at a 200k window, ignores
// autoCompactWindow, and loads every MCP tool schema up front instead of deferring
// them behind tool search. The relay only forwards to Anthropic, so say so.
const ASSUME_FIRST_PARTY_ENDPOINT = "_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL";
const THIRD_PARTY_PROVIDER_FLAGS = [
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  "CLAUDE_CODE_USE_ANTHROPIC_AWS",
  "CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD",
  "CLAUDE_CODE_USE_MANTLE",
  "CLAUDE_CODE_USE_GATEWAY",
] as const;

function isFirstPartyAnthropicEndpoint(env: Environment): boolean {
  if (THIRD_PARTY_PROVIDER_FLAGS.some((flag) => isTruthyFlag(env[flag]))) return false;
  const endpoint = env.ANTHROPIC_BASE_URL?.trim();
  if (!endpoint) return true;
  try {
    const url = new URL(endpoint);
    return url.protocol === "https:" && url.hostname === "api.anthropic.com";
  } catch {
    return false;
  }
}

// Claude Code's own reading of a boolean environment flag.
function isTruthyFlag(value: string | undefined): boolean {
  return ["1", "true", "yes", "on"].includes(value?.trim().toLowerCase() ?? "");
}

/**
 * Environment for a Claude CLI routed through a temporary local relay. Tags the
 * relay so descendant app launches can recover its upstream, and keeps the CLI's
 * first-party behavior when that upstream is Anthropic's own API.
 */
export function claudeSessionProxyEnvironment(env: Environment, baseUrl: string) {
  return {
    ANTHROPIC_BASE_URL: baseUrl,
    T3CODE_CLAUDE_PROXY_BASE_URL: baseUrl,
    T3CODE_CLAUDE_PROXY_UPSTREAM: env.ANTHROPIC_BASE_URL ?? "",
    ...(isFirstPartyAnthropicEndpoint(env) ? { [ASSUME_FIRST_PARTY_ENDPOINT]: "1" } : {}),
  };
}
