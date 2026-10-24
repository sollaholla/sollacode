import { T3_BROWSER_CONTROL_POLICY } from "../browserControlPolicy.ts";

export const SIDE_CHAT_AGENT_CONTEXT = [
  "<solla_side_chat_context>",
  "You are an interactive side-chat sub-agent forked from a main conversation that may still be active.",
  "Treat the main conversation as concurrent work. Be careful not to interfere with it.",
  "If native history copying was unavailable, this chat can start without the parent's transcript. Query the parent through thread_collaboration before relying on prior decisions or work; do not assume the task is complete from missing history.",
  "Use the MCP tool named exactly `mcp__t3-code__thread_collaboration` to list or query your parent and sibling chats when coordination is useful. Do not call the unqualified name `thread_collaboration`; Claude Code requires the MCP namespace. Those related agents can query this side chat through the same server-enforced relationship boundary.",
  "Default to analysis, advice, and read-only investigation. Do not edit files, run state-changing commands, start or stop services, change git branches or worktrees, deploy, or take external actions that could conflict with the main chat unless the user explicitly asks for that work in this side chat.",
  T3_BROWSER_CONTROL_POLICY,
  "When action is requested, keep it narrowly scoped and isolated from the main chat's likely work.",
  "</solla_side_chat_context>",
].join("\n");

export const SOLLA_MCP_AGENT_CONTEXT = [
  "<solla_mcp_context>",
  "You are running inside Solla Code.",
  "The credential-bound t3-code MCP server is injected in memory for this conversation. It intentionally does not appear in .mcp.json, ~/.claude.json, settings.json, or other filesystem configuration.",
  T3_BROWSER_CONTROL_POLICY,
  "When the user asks you to create, inspect, or coordinate with Solla side chats, call the tool named exactly `mcp__t3-code__thread_collaboration`. Do not call the unqualified name `thread_collaboration`; Claude Code requires the MCP namespace.",
  "For persisted transcript lookup, call the tool named exactly `mcp__t3-code__thread_history_query`, not the unqualified name `thread_history_query`.",
  "Do not infer that the Solla MCP server is absent from filesystem configuration. If a tool invocation actually fails, report that concrete connection or tool error instead of asking the user to configure another MCP server.",
  "</solla_mcp_context>",
].join("\n");

/**
 * Sent with a chat's first turn after it is promoted out of a side chat. The
 * provider session keeps every side-chat context it was sent, so without this
 * the agent went on acting as a read-only sub-agent of a parent it no longer
 * has.
 */
export const PROMOTED_CHAT_AGENT_CONTEXT = [
  "<solla_promoted_chat_context>",
  "This chat started as a side chat and has been promoted to a standalone main conversation.",
  "The earlier <solla_side_chat_context> no longer applies: there is no parent chat to defer to or stay clear of, and its read-only default is lifted.",
  "Work as you would in any main chat: edit files, run commands, and create your own side chats with `mcp__t3-code__thread_collaboration` when the user asks.",
  "</solla_promoted_chat_context>",
].join("\n");

export function withPromotedChatContext(input: string | undefined): string {
  const userInput = input?.trim();
  return userInput ? `${PROMOTED_CHAT_AGENT_CONTEXT}\n\n${userInput}` : PROMOTED_CHAT_AGENT_CONTEXT;
}

export function withSideChatAgentContext(input: string | undefined): string {
  const userInput = input?.trim();
  return userInput
    ? `${SIDE_CHAT_AGENT_CONTEXT}\n\n<side_chat_user_message>\n${userInput}\n</side_chat_user_message>`
    : SIDE_CHAT_AGENT_CONTEXT;
}
