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
  "mcpBridge",
] as const;

export type BuiltInProviderDriverKind = (typeof BUILT_IN_PROVIDER_DRIVER_KINDS)[number];
