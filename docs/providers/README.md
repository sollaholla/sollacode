# Providers

Solla Code connects to provider runtimes installed or configured on the environment host. Credentials and executable availability belong to that host, including when the client connects remotely.

The authoritative built-in list is [`builtInDrivers.ts`](../../apps/server/src/provider/builtInDrivers.ts). A provider's descriptor determines its models, permission modes, and optional operations; clients must not infer capabilities from the provider name alone.

| Driver              | Integration                                                       | Documentation                                                                              |
| ------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Codex               | Codex CLI app-server                                              | [Prerequisites](../getting-started/codex-prerequisites.md), [provider details](./codex.md) |
| Claude Code         | Claude Agent SDK                                                  | [Provider details](./claude.md)                                                            |
| Cursor              | Cursor runtime adapter                                            | [Architecture](../architecture/providers.md)                                               |
| Grok                | ACP runtime adapter                                               | [Architecture](../architecture/providers.md)                                               |
| Antigravity         | `agy` headless stream-JSON sessions                               | [Setup and capabilities](./antigravity.md)                                                 |
| OpenCode            | OpenCode server and SDK                                           | [Architecture](../architecture/providers.md)                                               |
| External MCP bridge | User-configured executable implementing `solla.provider-bridge/1` | [Bridge contract](./mcp-bridge.md)                                                         |

Antigravity has a built-in driver, model discovery, and a session adapter. Its text-only headless transport has narrower capabilities than the interactive CLI; see its capability notes before configuring agent workflows.

For user-facing behavior, see [usage and resets](../user/provider-usage.md), [usage-limit failover](../user/provider-failover.md), [account switching](../user/provider-account-switching.md), and [composer controls](../user/composer.md).
