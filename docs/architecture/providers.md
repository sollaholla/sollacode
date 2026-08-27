# Provider architecture

The web app communicates with the server via WebSocket using a simple JSON-RPC-style protocol:

- **Request/Response**: `{ id, method, params }` → `{ id, result }` or `{ id, error }`
- **Push events**: typed envelopes with `channel`, `sequence` (monotonic per connection), and channel-specific `data`

Push channels: `server.welcome`, `server.configUpdated`, `terminal.event`, `orchestration.domainEvent`. Payloads are schema-validated at the transport boundary (`wsTransport.ts`). Decode failures produce structured `WsDecodeDiagnostic` with `code`, `reason`, and path info.

Methods mirror the `NativeApi` interface defined in `@t3tools/contracts`:

- `providers.startSession`, `providers.sendTurn`, `providers.interruptTurn`
- `providers.respondToRequest`, `providers.stopSession`
- `shell.openInEditor`, `server.getConfig`

Built-in drivers materialize scoped provider instances for Codex, Claude, Cursor, Grok, OpenCode, and the generic `mcpBridge` external-provider contract. The provider-instance registry owns each instance scope, so disabling, removing, or reconfiguring one instance releases only that instance’s processes and sessions.

Mid-turn human input is dispatched on a per-thread priority lane and carries the exact provider
instance and active turn it was meant to steer. The service does not resume or replace a session for
that request, and each adapter validates the target again at its native send boundary. If the target
has ended or a successor now owns the session, the adapter fails closed and orchestration re-arms the
durable queued delivery. Synthetic Agent continuations and startup auto-resume prompts stay on the
ordinary work lane.

Grok background commands arrive as `_x.ai/session/update` (`task_backgrounded` / `task_completed`) or the dedicated `_x.ai/task_*` notifications. The Grok adapter maps those onto the shared `task.started` / `task.completed` stream so the right-panel task list and agent-mode continuation wait on them. Per-task stop is `_x.ai/task/kill`.

Grok provider health checks only `initialize` and `authenticate`. They do not call `session/new`, because Grok waits there for the user's own MCP servers (including npx plugins) and a hung plugin used to mark a working CLI as "ACP startup timed out". After authenticate they also call `_x.ai/billing` so Refresh on the usage pill is not stuck on a 15-minute-old snapshot. A handshake that still times out is a warning with built-in models, not a hard error.

Grok sessions bound MCP plugin startup (`GROK_MCP_STARTUP_TIMEOUT_SECS=8`) and cap `session/new` at 45s so a stuck npx server cannot freeze the GUI while `grok` in a TTY still comes up.

Grok (and other ACP agents) stream `agent_thought_chunk` before the first `agent_message_chunk`. High-effort Grok 4.6 / Grok Build can think for a long time in that gap. The adapter maps those chunks onto `reasoning_text` and a single collapsed "Thinking" activity so the chat timeline moves as soon as the TTY would, instead of sitting blank until the first spoken token.

Grok sessions run with concurrent prompts (`concurrentPrompts` on the ACP session runtime). Grok queues overlapping `session/prompt` requests itself (visible in `_x.ai/queue/changed`) and runs each at the next turn boundary; serializing them client-side left mid-turn user messages stuck inside our process. The queue notification is the admission receipt, so the UI can distinguish a locally persisted message from one Grok has actually accepted even while the prompt RPC remains open. An empty-composer second Enter dispatches on the immediate control lane and sends `x.ai/queue/interject` once for every waiting row, oldest first. Stop remains separate: it sends two JSON-RPC 2.0 `session/cancel` notifications (no `id`, with `_meta.cancelTrigger: "esc"`) before interrupting in-flight prompt RPCs. Encoding cancel as a request with an empty `id` is ignored by Grok.

Grok models advertise reasoning-effort levels in ACP model metadata (`_meta.supportsReasoningEffort` / `reasoningEfforts`). Because health checks skip `session/new`, discovery reads the catalog from the `initialize` response `_meta.modelState` (which mirrors ACP's `SessionModelState`) and maps the levels onto the standard `effort` model-option descriptor so the composer shows the same dropdown as other providers, and the adapter applies a selection through `session/set_model` with `_meta.reasoningEffort` (confirmed back by a `model_changed` notification). `session/set_config_option` does not exist on Grok.

## External MCP provider driver

`mcpBridge` launches one user-configured local executable per enabled provider instance with the official MCP TypeScript SDK `StdioClientTransport`. All Solla threads for that instance are multiplexed over the one stdio process, but every application operation includes an explicit Solla thread/session ID. MCP supplies transport and JSON-RPC; `solla.provider-bridge/1` is Solla’s separately versioned provider lifecycle and event contract.

The driver validates the external descriptor before use, maps and validates ordered events, deduplicates external event IDs, then stamps Solla driver/instance/thread identity. A stale event cursor triggers `thread_read` resynchronization. Descriptor capabilities decide whether model switching happens in-session or by rotating the provider session; they also gate turn/task stop, auxiliary text generation, rollback, and fork behavior. See [External MCP provider bridges](../providers/mcp-bridge.md).

## Client transport

`wsTransport.ts` manages connection state: `connecting` → `open` → `reconnecting` → `closed` → `disposed`. Outbound requests are queued while disconnected and flushed on reconnect. Inbound pushes are decoded and validated at the boundary, then cached per channel. Subscribers can opt into `replayLatest` to receive the last push on subscribe.

## Server-side orchestration layers

Provider runtime events flow through queue-based workers:

1. **ProviderRuntimeIngestion** - consumes provider runtime streams, emits orchestration commands
2. **ProviderCommandReactor** - reacts to orchestration intent events, dispatches provider calls
3. **CheckpointReactor** - captures git checkpoints on turn start/complete, publishes runtime receipts

All three use `DrainableWorker` internally and expose `drain()` for deterministic test synchronization.
