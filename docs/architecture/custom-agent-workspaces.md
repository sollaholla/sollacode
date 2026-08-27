# Custom-agent workspace architecture

Custom-agent workspaces extend the existing Agent Stack (agents work in their thread's collaborative preview browser). They do not introduce a generic agent class or a second conversation model.

## Data and contracts

The shared schemas in `packages/contracts/src/vm.ts` define tasks, task runs, notifications, preferences, and the safe artifact vocabulary. WebSocket RPC definitions live in `packages/contracts/src/rpc.ts` and are authorized with the existing VM operate scope.

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

The `agent_workspace` MCP tool is guarded by the `vm` invocation capability. It derives the caller from the credential-bound thread through `VmAgentStore.getByThreadId`; callers cannot supply another agent id. Agent-created recurrence requires user approval. Artifact input is decoded against the declarative contract before persistence.

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

Agent ids are always paired with an environment id in client routes. The server payload can omit the
environment because the selected connection already determines its authority boundary.
