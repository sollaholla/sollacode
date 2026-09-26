# Claude connections

Each Claude chat uses a local proxy owned by that session. Starting or updating Solla Code from an
agent restores the configured API upstream before launching the backend or other providers. The
temporary proxy address is never reused as the next app's API upstream. This prevents connection
refusals after the original session exits.

Version 0.1.433 also repairs the untagged local proxy environment inherited from earlier releases on
startup. Provider-specific environment settings are applied after that repair, so an explicitly
configured `ANTHROPIC_BASE_URL` still takes precedence. Remote clients use their server's connection
settings; they do not need new pairing credentials for this repair.

## Full context window and deferred MCP tools

Claude Code decides whether an endpoint is Anthropic's own API by its address. The local proxy's
address is not, so before version 0.1.648 every Claude chat was treated as a third-party gateway:

- Opus 5.5, Opus 4.8, and Opus 4.7 ran with a 200k window and compacted at about 167k tokens,
  while Solla's context meter still showed plenty of room.
- Claude loaded the full schema of every MCP tool into each request instead of deferring them
  behind tool search. About 60k tokens were gone before the chat started.

Together, a chat compacted again every few file reads and could spend more time compacting than
working. The proxy now tells Claude Code that it forwards to Anthropic's API whenever the configured
upstream really is `https://api.anthropic.com` or unset. Chats get the full 1M window, Solla's
compaction point, and deferred MCP tools. The claim is never made for OpenRouter, Claude Code
Router, or other gateways, or when a `CLAUDE_CODE_USE_*` cloud or gateway mode such as Bedrock,
Vertex, or Foundry is on. Those keep Claude Code's own gateway behavior.

Existing chats get the full window and Solla's compaction point when their Claude session next
starts. Deferred MCP tools start with the next new Claude session; a resumed conversation keeps the
tool definitions it already sent.

## Model discovery

Claude models and their options refresh from the installed CLI automatically, separately for each
account. You can also refresh the provider in Settings → Providers. New models keep exact IDs,
so your saved selections and model restrictions remain in effect. See
[Claude model discovery and Opus 5.5](../providers/claude.md#models-update-automatically).
