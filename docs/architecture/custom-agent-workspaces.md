# Custom-agent workspace architecture

Custom-agent workspaces extend the existing Agent Stack (agents work in their thread's collaborative preview browser). They do not introduce a generic agent class or a second conversation model.

## Data and contracts

The shared schemas in `packages/contracts/src/vm.ts` define tasks, task runs, notifications, preferences, and the artifact vocabulary (structured views plus an HTML/CSS dashboard). WebSocket RPC definitions live in `packages/contracts/src/rpc.ts` and are authorized with the existing VM operate scope.

Migration 051 adds five environment-local SQLite tables:

- `vm_agent_tasks`
- `vm_agent_task_runs`
- `vm_agent_artifacts`
- `vm_agent_notifications`
- `vm_agent_notification_preferences`

Foreign keys cascade from `vm_agents`. A partial unique index permits only one queued, booting, or running scheduled run per agent.

## Scheduler

`VmAgentTaskScheduler` is one scoped server worker with a coalesced wake queue and a one-second due-work scan. There is no timer or process per task. The scheduler uses deterministic command and message identifiers derived from the run id, so recovery can safely redispatch a command after a crash.

Completed workspace tasks remain visible for one hour after their completed transition, then a server retention sweep deletes the task and its run history. The sweep runs at startup and once per minute, excludes delegation-owned tasks, and will not delete a task with a live run. Reactivating a completed task before expiry preserves it.

Before dispatch it checks the projected dedicated thread and defers when a turn or pending work exists. This preserves the custom agent's one-conversation invariant and makes queue state visible instead of superseding an undelivered instruction.

Running task completion is observed through the existing `projection_turns.pending_message_id` relationship. Terminal projection state finalizes the run, updates one-time task state after success, and emits a deduplicated notification.

## Agent authority

The `agent_workspace` MCP tool is guarded by the `vm` invocation capability. It derives the agent from the credential-bound thread with `resolveOwningVmAgent` ([owningAgent.ts](../../apps/server/src/vm/owningAgent.ts)), which walks the side-chat chain, so the agent's side chats and its delegated workers act as that agent; callers cannot supply another agent id. `call_user` from any of them rings as the agent, and an answered call talks in the agent's main chat, because `AgentCallLive` pins the voice session to `agent.threadId`. Agent-created recurrence requires user approval. So does any task added, or whose title, prompt, criteria or schedule changes, in a turn that received another chat's message or delegated work, the rule `request_action_approval` follows (see [Cross-chat messages](#cross-chat-messages)). Artifact input is decoded against the contract before persistence. An `html` dashboard is stored as markup and rendered in the same opaque iframe sandbox as a thread web artifact.

The hidden Agents project remains the organizational parent for agent chats, but it is not their
shared execution directory. Every newly created named agent receives a readable, uniquely suffixed
subdirectory below the environment's agents root, and its dedicated thread stores that directory as
its effective provider cwd. Renaming an agent does not move its files, and reusing a deleted name
cannot collide with the prior directory. Legacy agents retain their existing shared cwd so an
upgrade never guesses which agent owns older shared files.

## Client delivery

`packages/client-runtime` owns the environment-scoped workspace stream and serialized mutation commands. The web client renders scheduled work, structured dashboards, blockers, and independent alerts around the agent's existing Chat surface. Desktop inherits the web surface through Electron. Native notifications are a best-effort delivery channel; persisted workspace state is authoritative for local, LAN, relay, and tunnel clients. Blockers and notifications are separate records and separate attention counts: a waiting-on-you blocker must never create or require a derivative notification row.

Bounded collaboration has a separate environment-scoped stream. A snapshot carries named-agent
capability and availability summaries plus compact delegation list rows: relationship ids, compact
identity snapshots, status and counts, timestamps, and bounded task/result/error previews. Full
requests, results, errors, and completion settings are fetched only for the selected delegation.
Conversation history is read newest-first in bounded pages; clients fetch older pages explicitly
and refresh the newest page when the stream's delegation revision changes, rather than polling the
entire history. Messages identify source agent, target agent, user, or system and preserve
pending/delivered state. Creation remains an agent/MCP action; clients observe, send bounded
follow-ups, cancel, and route human approvals back to the root thread.

`agent_collaboration` resolves its actor in order: a delegated worker thread is the worker (so it
stays one generation deep), then `resolveOwningVmAgent` makes an agent's chat or side chat the
agent. Any other chat has no actor: it may `list_agents`, and every other action is refused with a
pointer to `workspace_consult`.

Agent ids are always paired with an environment id in client routes. The server payload can omit the
environment because the selected connection already determines its authority boundary.

## Cross-chat messages

`workspace_consult` ([consult/handlers.ts](../../apps/server/src/mcp/toolkits/consult/handlers.ts))
is the one message door between chats, open to every credential with the default `collaboration`
capability, including terminal agent CLIs. Delegation and `agent_builder` stay agent-only and
builder-only. The sender is stamped on the delivered message as `senderThreadId` (always the real
calling thread) and `senderThreadTitle` (the owning agent's name for an agent's chats, the
orchestrator's title only for the orchestrator thread itself, otherwise the caller's title). A thread opened with `ask` and a `projectId` records `createdByThreadId` and
inherits the caller's browser profile; clients name the creator from that id
([threadProvenance.ts](../../packages/client-runtime/src/state/threadProvenance.ts)).

The guards need no new storage:

- Targets of `ask`, `list_threads` and `read_thread` exclude the caller's whole side-chat family
  (from `resolveRelatedChats`, plus the owning agent's chat, since asking a parent or child
  deadlocks), the orchestrator, Agent Builder threads and `delegation-worker:*` threads. Asking a
  stopped (or stopping) agent's chat is refused.
- `ProjectionSnapshotQuery` reads a turn's provenance: the `senderThreadId` and `delegationId` of
  the messages a thread's active (or latest) turn received, including ones steered into it while it
  ran, and for an agent-loop continuation, those of the last message that was not a continuation.
  Before an `ask`, the handler walks those senders from the caller and refuses a target already in
  the chain (a cycle) or a chain already three hops deep. A message from the orchestrator ends the
  chain, as the person.
- Each caller may `ask` 20 times in a sliding 10-minute window (in memory, on the Effect clock), and
  may have at most 10 non-archived threads it created. An active delegated worker may not open new
  threads.
- `ask` waits on the target thread's domain events rather than polling, up to `waitMs` (a minute by
  default, at most two; 0 only sends). Once the target's latest turn settles, the answer is that
  turn's assistant reply written after the question, so a question steered into a running turn is
  answered by that turn. A provider that declares `liveSteering: "unsupported"` (Kimi, Deep Code,
  Antigravity) cannot take it mid-turn, so `ProviderCommandReactor` interrupts the running turn and
  the question runs next, as it does for any message sent mid-turn.

`request_action_approval` reads the same provenance: in Agent mode a turn approves itself only when
no message it received has a `delegationId` or a sender other than the orchestrator, and an
agent-loop continuation inherits the answer from the message before it. `agent_workspace` applies
the same rule to tasks: one added or changed in such a turn is saved as a pending draft.
