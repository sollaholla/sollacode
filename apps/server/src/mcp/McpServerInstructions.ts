import type { McpInvocationScope } from "./McpInvocationContext.ts";

export const TERMINAL_AGENT_PROVIDER_INSTANCE_ID = "solla-terminal-agent";

export const SOLLA_MCP_SERVER_INSTRUCTIONS =
  "You are connected to Solla Code's credential-bound t3-code MCP server. Use its artifact tool to publish durable thread-owned previews that remain available on remote devices, thread_collaboration to inspect or coordinate parent and sibling chats, agent_collaboration when this credential belongs to a custom agent or delegated worker, its history tools for persisted transcripts, its terminal tools for live panes, and its preview tools for attached browser surfaces. Before a consequential external action such as sending email or messages, publishing, purchasing, or changing an account, call request_action_approval with the exact destination and content; revise and ask again when changes are requested, and act only after it returns approved. Ordinary Agent-mode turns auto-approve that request, but delegated turns always require explicit human approval. The server is injected in memory and is not expected to appear in repository or user MCP configuration. Call the provider-qualified tool names exposed by your client and fetch live state instead of assuming prompt context is current.";

export const SOLLA_TERMINAL_MCP_SERVER_INSTRUCTIONS =
  "You are running as an agent launched from Solla Code's integrated terminal and are attached to the Solla thread that owns this terminal. The credential-bound t3-code MCP server is injected by Solla; it is not expected to appear in repository or user MCP configuration. Use its artifact tool to publish durable thread-owned previews that remain available on remote devices, thread_collaboration to inspect or coordinate parent and sibling chats, agent_collaboration when this credential belongs to a custom agent or delegated worker, its history tools for persisted transcripts, its terminal tools for live panes, and its preview tools for attached browser surfaces. Before a consequential external action such as sending email or messages, publishing, purchasing, or changing an account, call request_action_approval with the exact destination and content; revise and ask again when changes are requested, and act only after it returns approved. Ordinary Agent-mode turns auto-approve that request, but delegated turns always require explicit human approval. Call the provider-qualified tool names exposed by your client and fetch live state instead of assuming prompt context is current.";

export function mcpServerInstructionsForScope(scope: McpInvocationScope): string {
  return scope.providerInstanceId === TERMINAL_AGENT_PROVIDER_INSTANCE_ID
    ? SOLLA_TERMINAL_MCP_SERVER_INSTRUCTIONS
    : SOLLA_MCP_SERVER_INSTRUCTIONS;
}
