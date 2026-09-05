import type { ProviderInstanceEnvironment } from "@t3tools/contracts";

export function mergeProviderInstanceEnvironment(
  environment: ProviderInstanceEnvironment | undefined,
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = { ...baseEnv };
  // Provider credentials are minted for each session. A desktop or terminal
  // ancestor can carry a revoked token belonging to an earlier runtime.
  delete next.T3_MCP_BEARER_TOKEN;
  delete next.SOLLA_TERMINAL_MCP_BEARER_TOKEN;
  delete next.SOLLA_TERMINAL_MCP_ENDPOINT;
  for (const variable of environment ?? []) {
    next[variable.name] = variable.value;
  }
  return next;
}
