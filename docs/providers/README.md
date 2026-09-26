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
| Deep Code           | `deepcode --exec` text sessions                                   | [Setup and capabilities](./deepcode.md)                                                    |
| Muse Code           | `muse serve` MSP sessions over stdio                              | [Setup and capabilities](./muse.md)                                                        |
| OpenCode            | OpenCode server and SDK                                           | [Tracking, free models, and Jev](./opencode.md)                                            |
| External MCP bridge | User-configured executable implementing `solla.provider-bridge/1` | [Bridge contract](./mcp-bridge.md)                                                         |

Antigravity has a built-in driver, model discovery, and a session adapter. Its text-only headless transport has narrower capabilities than the interactive CLI; see its capability notes before configuring agent workflows.

Deep Code has a built-in driver, DeepSeek models, effort selection, and native session resume through `deepcode --exec`. Headless exec cannot confirm permission prompts and does not stream tool activity; see [Deep Code](./deepcode.md).

Muse Code speaks MSP, a JSON-RPC session protocol over the stdio of a long-lived `muse serve` host. Unlike the one-shot CLIs it streams reasoning and tool calls live, steers a running turn natively, and takes images as wire input; see [Muse Code](./muse.md).

## Installing a provider CLI

Every built-in provider that is a CLI can be installed from Settings: an instance whose binary is missing shows an **Install** button beside its name, which runs the install on the environment host and re-probes. The command is resolved per host — the package manager that already owns the binary (npm, bun, pnpm, or Homebrew) when one does, and otherwise the vendor's own installer for CLIs that do not publish to a registry (`agy`, `cursor-agent`). The popover shows the exact command before it runs, for anyone who would rather paste it into a terminal.

Installing never signs the CLI in. Each provider's authentication is its own step, described in its page above.

For user-facing behavior, see [usage and resets](../user/provider-usage.md), [usage-limit failover](../user/provider-failover.md), [account switching](../user/provider-account-switching.md), and [composer controls](../user/composer.md).
