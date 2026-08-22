# External MCP provider bridges

## What this is

The built-in `mcpBridge` driver lets a user connect an independently installed coding provider to Solla Code over local MCP stdio. Solla contains the generic driver and the versioned `solla.provider-bridge/1` contract only. It does not download, bundle, publish, special-case, or write configuration for any particular external bridge.

## Configure an instance

In Settings, add a provider and choose **MCP Provider Bridge**. Configure:

| Field             | Meaning                                                                                           |
| ----------------- | ------------------------------------------------------------------------------------------------- |
| Command           | Required absolute path to an executable or executable script                                      |
| Arguments         | Optional; each non-empty line is passed as one literal argv entry                                 |
| Working directory | Optional absolute directory used as the child process cwd                                         |
| Environment       | Per-instance variables; mark secrets sensitive so Solla’s existing redaction/storage path applies |

Solla passes the command and argument vector directly to the official MCP SDK [`StdioClientTransport`](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/clients/connect.md); it does not parse a shell expression or expand spaces, globs, backticks, or substitutions. Invalid and unavailable configurations stay in settings so they can be edited; their runtime snapshot reports the failure instead of silently deleting the instance.

Each child also receives the reserved `SOLLA_PROVIDER_INSTANCE_ID` environment variable. External bridges can use this stable, non-secret identifier to namespace resumable state when the same command is configured more than once. It overrides a same-named user environment entry so it always identifies the actual owning instance.

## LAN Chat example

For a separately owned checkout of LAN Chat Bridge on this machine, the pasteable command is:

```text
command: /Users/example/Projects/provider-bridge/scripts/provider-bridge-launch.sh
arguments: (empty)
working directory: (empty)
```

This path is documentation only. It is not a compiled default, dependency, installer action, download, publication, or mutation of live Solla user data.

## Contract and capability negotiation

Every tool request and response includes:

```text
solla.provider-bridge/1
```

Initialization calls `provider_bridge.describe` and rejects a version mismatch or malformed descriptor. The descriptor supplies provider name/version, health, models/default model, limits, and capability flags. The settings snapshot shows the negotiated identity, version, models, health, and flags.

Version 1 defines no rollback or fork RPC operations, so `threadRollback` and `threadFork` must both be `false`; Solla rejects a v1 descriptor that claims otherwise instead of advertising an action it cannot execute. A later contract version can add those operations explicitly.

Required MCP tools are:

- `provider_bridge.describe`
- `provider_bridge.session_start`
- `provider_bridge.turn_start`
- `provider_bridge.turn_steer`
- `provider_bridge.events_next`
- `provider_bridge.turn_interrupt`
- `provider_bridge.request_respond`
- `provider_bridge.user_input_respond`
- `provider_bridge.session_stop`
- `provider_bridge.sessions_list`
- `provider_bridge.thread_read`
- `provider_bridge.generate_text`
- `provider_bridge.shutdown`

Every session operation has an explicit `sessionId`. `turn_start` returns promptly with a `turnId` and opaque resume cursor. Solla long-polls ordered events for at most 25 seconds, validates envelopes/sequences/session identity, deduplicates `eventId`, and resynchronizes with `thread_read` when the bridge reports a cursor gap. Unsupported rollback, fork, stop, or text generation is gated from the corresponding Solla workflow rather than reported as successful. When in-session model switching is unsupported, Solla rotates to a fresh provider session on the same thread and carries a compact conversation handoff forward.

### Messages sent during a running turn

A bridge may advertise `turnSteering:true`. When the user presses Enter during
an active provider turn, Solla calls `provider_bridge.turn_steer` with the
session's exact `activeTurnId` as `expectedTurnId`, the persisted message ID,
and attachment-free text. A successful response must acknowledge that same
turn ID with `accepted:true`; Solla then resolves the durable queued-delivery
obligation without creating a second provider turn. If steering is unsupported,
stale, ambiguous, or fails, the obligation remains queued and is delivered as
a normal next turn when the active turn reaches a boundary. Follow-ups with
attachments always use that queued fallback.

Provider and interaction-setting messages are control turns, not steering
text: Solla interrupts the old turn when possible and applies them on a fresh
turn. Leaving Agent mode is also authoritative at delivery time. An already
projected synthetic Agent continuation is cancelled before provider dispatch
when the current thread or shell mode is no longer `agent`.

## Lifecycle ownership

One enabled Solla provider instance owns one stdio child. All of that instance’s Solla sessions share the child; another provider instance gets a separate child and lifecycle.

- Disable, remove, reconfigure, or shut down the server: Solla calls `provider_bridge.shutdown`, closes the MCP client, and lets the SDK escalate the instance-owned child from stdin close to termination if required.
- Child failure: only that instance connection is retired; the next operation reconnects after bounded exponential backoff.
- External resources: the bridge itself must distinguish resources it created from resources it merely reused. Solla never signals a process outside its own `StdioClientTransport`.
- Diagnostics: stderr is retained in a bounded buffer and sensitive configured values are redacted. Stdout must contain MCP protocol messages only.

## Event mapping

The application event envelope contains an external event ID, monotonic sequence, timestamp, session ID, optional turn/item/request IDs, canonical type, and payload. Solla validates external data before mapping it to provider runtime events and adds its own driver, provider-instance, and thread identity. Bridges backed by snapshot-oriented systems should publish one authoritative completed assistant-content event, not both incremental fragments and cumulative snapshots.

Approval and structured-user-input requests flow through Solla’s existing request APIs with both session and request identity. An external bridge is responsible for suspending and resuming its pending work after the scoped response.

## Auxiliary text generation

Instances advertising `textGeneration:true` can participate in title, branch, commit, pull-request, and plan metadata generation through `provider_bridge.generate_text`. Instances advertising `false` are excluded from the text-generation provider selectors.

## Trust boundary

An external stdio provider is local software selected by the user. As documented by the [MCP security model](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/SECURITY.md), it runs with the Solla host user’s privileges and receives its configured cwd/environment. MCP is the transport boundary, not an operating-system sandbox. Review the command and bridge source, use the narrowest environment/workspace practical, and do not treat approval UI or bridge path checks as containment against a malicious executable.

## Troubleshooting

The provider card distinguishes configuration/initialization errors, degraded descriptor health, and a ready external provider. Check, in order:

1. Command and working-directory paths are absolute and exist.
2. The script is executable and runs without shell-specific setup.
3. Stdout contains only MCP JSON; startup logs belong on stderr.
4. The bridge lists every required tool and returns exactly `solla.provider-bridge/1`.
5. The descriptor advertises the selected model/capability.
6. Review the bounded, redacted bridge stderr shown in the provider error.
