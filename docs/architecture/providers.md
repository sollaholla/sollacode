# Provider architecture

Clients use the Effect RPC contracts in [`packages/contracts/src/rpc.ts`](../../packages/contracts/src/rpc.ts). User actions become orchestration commands through the shared client runtime. Clients do not call provider adapters directly. HTTP handles environment discovery, authentication, snapshots, and history; authenticated WebSocket RPC handles interactive operations and subscriptions. See [Connection runtime](./connection-runtime.md).

Built-in drivers materialize scoped provider instances for Codex, Claude, Cursor, Grok, OpenCode, Antigravity, and the generic `mcpBridge` external-provider contract. The provider-instance registry owns each instance scope, so disabling, removing, or reconfiguring one instance releases only that instance’s processes and sessions.

Mid-turn human input is dispatched on a per-thread priority lane and carries the exact provider
instance and active turn it was meant to steer. The service does not resume or replace a session for
that request, and each adapter validates the target again at its native send boundary. If the target
has ended or a successor now owns the session, the adapter fails closed and orchestration re-arms the
durable queued delivery. Synthetic Agent continuations and startup auto-resume prompts stay on the
ordinary work lane. A mid-turn Grok follow-up that was already delivered into the live turn is a
steer, not later user intent: native synthetic-dispatch admission must not cancel the resume after
the auto-resume message is already in the thread. Repeated steers for the same live provider target
remain FIFO through provider-native admission, but the next steer does not wait for the previous
prompt response to finish. Grok exposes that admission boundary from its concurrent ACP prompt
runtime; providers whose send call is already an admission acknowledgement release the lane when
that call returns.

Grok background commands arrive as `_x.ai/session/update` (`task_backgrounded` / `task_completed`) or the dedicated `_x.ai/task_*` notifications. The Grok adapter maps those onto the shared `task.started` / `task.completed` stream so the right-panel task list and agent-mode continuation wait on them. Per-task stop is `_x.ai/task/kill`.

Grok provider health checks only `initialize` and `authenticate`. They do not call `session/new`, because Grok waits there for the user's own MCP servers (including npx plugins) and a hung plugin used to mark a working CLI as "ACP startup timed out". After authenticate they also call `_x.ai/billing` so Refresh on the usage pill is not stuck on a 15-minute-old snapshot. A handshake that still times out is a warning with built-in models, not a hard error.

Grok sessions bound MCP plugin startup (`GROK_MCP_STARTUP_TIMEOUT_SECS=8`) and cap `session/new` at 45s so a stuck npx server cannot freeze the GUI while `grok` in a TTY still comes up.

Grok (and other ACP agents) stream `agent_thought_chunk` before the first `agent_message_chunk`. High-effort Grok 4.6 / Grok Build can think for a long time in that gap. The adapter maps those chunks onto `reasoning_text` and a single collapsed "Thinking" activity so the chat timeline moves as soon as the TTY would, instead of sitting blank until the first spoken token.

Grok sessions run with concurrent prompts (`concurrentPrompts` on the ACP session runtime). Grok queues overlapping `session/prompt` requests itself (visible in `_x.ai/queue/changed`) and runs each at the next turn boundary; serializing them client-side left mid-turn user messages stuck inside our process. The queue notification is the admission receipt, so the UI can distinguish a locally persisted message from one Grok has actually accepted even while the prompt RPC remains open. About a second after the last waiting row is admitted — or immediately on empty-composer Enter / **Send queued now** — clients dispatch a dedicated per-thread promotion for the oldest uncovered message ID only. The adapter sends `x.ai/queue/interject` for that row, waits for its `message.delivered` read receipt, then the next row; interjecting the whole batch at once stalls Grok. The separate steer and cancellation lanes remain free to admit those targets or stop the session while promotion waits. A target must first appear in an authoritative native queue snapshot; an unrelated newer snapshot cannot prove that a not-yet-admitted target was already promoted. Promotion does not succeed when the notification is merely written or when a row merely disappears: it waits without a short wall-clock deadline for exact proof that Grok adopted the target as its running prompt or that the target's native prompt RPC was consumed successfully. A changed row version is retried once with the fresh version; an unchanged unrelated snapshot keeps waiting; a stopped session, ended native turn, failed target admission, or retained row produces a correlated terminal failure. The reactor filters IDs already covered by durable delivery or promotion activities, so a reload, process restart, or ambiguous transport retry can safely submit the same batch with a new request ID. It projects a request-correlated `provider.queue.promoted` or `provider.queue.promote.failed` terminal activity for the whole original batch so clients release only the matching lock. Stop remains separate: it sends two JSON-RPC 2.0 `session/cancel` notifications (no `id`, with `_meta.cancelTrigger: "esc"`) before interrupting in-flight prompt RPCs. Encoding cancel as a request with an empty `id` is ignored by Grok.

Grok models advertise reasoning-effort levels in ACP model metadata (`_meta.supportsReasoningEffort` / `reasoningEfforts`). Because health checks skip `session/new`, discovery reads the catalog from the `initialize` response `_meta.modelState` (which mirrors ACP's `SessionModelState`) and maps the levels onto the standard `effort` model-option descriptor so the composer shows the same dropdown as other providers, and the adapter applies a selection through `session/set_model` with `_meta.reasoningEffort` (confirmed back by a `model_changed` notification). `session/set_config_option` does not exist on Grok.

## External MCP provider driver

`mcpBridge` launches one user-configured local executable per enabled provider instance with the official MCP TypeScript SDK `StdioClientTransport`. All Solla threads for that instance are multiplexed over the one stdio process, but every application operation includes an explicit Solla thread/session ID. MCP supplies transport and JSON-RPC; `solla.provider-bridge/1` is Solla’s separately versioned provider lifecycle and event contract.

The driver validates the external descriptor before use, maps and validates ordered events, deduplicates external event IDs, then stamps Solla driver/instance/thread identity. A stale event cursor triggers `thread_read` resynchronization. Descriptor capabilities decide whether model switching happens in-session or by rotating the provider session; they also gate turn/task stop, auxiliary text generation, rollback, and fork behavior. See [External MCP provider bridges](../providers/mcp-bridge.md).

## Client transport

The shared `EnvironmentSupervisor` owns retries and the active session. `RpcSessionFactory` establishes one connection attempt, while shell and thread services own their subscriptions and caches. Transport readiness and data synchronization are separate states. See [Connection runtime](./connection-runtime.md) for ownership and failure behavior.

## Server-side orchestration layers

Provider runtime events flow through queue-based workers:

1. **ProviderRuntimeIngestion** - consumes provider runtime streams, emits orchestration commands
2. **ProviderCommandReactor** - reacts to orchestration intent events, dispatches provider calls
3. **CheckpointReactor** - captures git checkpoints on turn start/complete, publishes runtime receipts

The workers expose drain and receipt boundaries for deterministic test synchronization. Explicit Stop cancels pending work before provider teardown; late runtime notifications cannot reopen a stopped session.

Provider handoffs fence teardown by the outgoing provider instance and session creation time. The
outgoing control action conditionally releases only the projection it observed and preserves the
replacement delivery. A replacement that starts during the interrupt therefore retains its working
status, work obligation, and MCP credential. A failed native resume gets a new MCP credential before
the fresh fallback is spawned. Explicit Stop also checks live adapters when the projected chat status
is already stopped, so a disconnected chat cannot leave its CLI running unnoticed.

## Antigravity headless sessions

The Antigravity driver discovers models through `agy models` and starts one scoped `agy` subprocess for each turn. The native conversation ID is retained as the resume cursor for subsequent turns. A pure mapper translates stream-JSON frames into provider runtime events. Assistant deltas include text on both ACTIVE and DONE frames; the final result does not duplicate streamed text.

Interrupt marks the turn canceled before interrupting its fiber and closing the child process scope. A child that ignores graceful termination is forcibly terminated after two seconds. Late frames cannot override an interrupted terminal result. See [Antigravity](../providers/antigravity.md) for unsupported operations.
