/**
 * Every provider driver this build ships, as one list both sides check
 * against.
 *
 * A driver is registered in three unrelated places -- the server's
 * `BUILT_IN_DRIVERS`, the web Settings driver list, and the composer's
 * provider picker -- and nothing tied them together. Deep Code landed with a
 * working server driver that Settings never listed, so the provider could not
 * be added at all and the gap was found by a person, not a test.
 */
export const BUILT_IN_PROVIDER_DRIVER_KINDS = [
  "codex",
  "claudeAgent",
  "cursor",
  "grok",
  "opencode",
  "antigravity",
  "deepcode",
  "muse",
  "mcpBridge",
] as const;

export type BuiltInProviderDriverKind = (typeof BUILT_IN_PROVIDER_DRIVER_KINDS)[number];

/**
 * Drivers whose adapter mounts Solla's credential-bound t3-code MCP server on
 * each session, so tools such as `mcp__t3-code__thread_history_query` are
 * actually callable.
 *
 * Deep Code, Antigravity, and external/custom bridges spawn their own CLI and
 * never receive the server. A prompt that names the history tool to one of
 * those reads as a broken or denied integration, so the provider-handoff
 * reminder asks this list instead of assuming every provider has the tools.
 */
export const PROVIDER_DRIVER_KINDS_WITH_SOLLA_MCP_TOOLS = [
  "codex",
  "claudeAgent",
  "cursor",
  "grok",
  "opencode",
] as const satisfies ReadonlyArray<BuiltInProviderDriverKind>;

export function providerDriverHasSollaMcpTools(driver: string): boolean {
  return (PROVIDER_DRIVER_KINDS_WITH_SOLLA_MCP_TOOLS as ReadonlyArray<string>).includes(driver);
}
