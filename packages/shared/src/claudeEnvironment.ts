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
  delete env.T3CODE_CLAUDE_PROXY_BASE_URL;
  delete env.T3CODE_CLAUDE_PROXY_UPSTREAM;
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_ENTRYPOINT;
  delete env.CLAUDE_AGENT_SDK_VERSION;
}

/** Tag a temporary proxy so descendant app launches can recover its upstream. */
export function claudeSessionProxyEnvironment(env: Environment, baseUrl: string) {
  return {
    ANTHROPIC_BASE_URL: baseUrl,
    T3CODE_CLAUDE_PROXY_BASE_URL: baseUrl,
    T3CODE_CLAUDE_PROXY_UPSTREAM: env.ANTHROPIC_BASE_URL ?? "",
  };
}
