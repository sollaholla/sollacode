import type { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";

export interface McpProviderSessionConfig {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly providerSessionId: string;
  readonly providerInstanceId: ProviderInstanceId;
  readonly endpoint: string;
  readonly authorizationHeader: string;
  readonly shellBridgeInstructions?: string;
}

const sessionsByThread = new Map<ThreadId, McpProviderSessionConfig>();

export function setMcpProviderSession(config: McpProviderSessionConfig): void {
  sessionsByThread.set(config.threadId, config);
}

export function readMcpProviderSession(threadId: ThreadId): McpProviderSessionConfig | undefined {
  return sessionsByThread.get(threadId);
}

export function clearMcpProviderSession(threadId: ThreadId): void {
  sessionsByThread.delete(threadId);
}

export function clearAllMcpProviderSessions(): void {
  sessionsByThread.clear();
}

export function listMcpProviderSessions(): ReadonlyArray<McpProviderSessionConfig> {
  return [...sessionsByThread.values()];
}

/** Keep native one-line slash commands intact; they are parsed by the runtime. */
export function appendMcpShellBridgeInstructions(
  input: string | undefined,
  instructions?: string,
): string | undefined {
  if (!instructions || !input || /^\s*\/[\w-]+(?:[ \t]+[^\r\n]*)?\s*$/.test(input)) return input;
  return `${input}\n\n${instructions}`;
}
