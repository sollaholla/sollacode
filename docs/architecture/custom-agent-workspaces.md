# Custom-agent workspace architecture

Custom-agent workspaces extend the existing VM-backed Agent Stack. They do not introduce a generic agent class or a second conversation model.

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

Before dispatch it checks the projected dedicated thread and defers when a turn or pending work exists. This preserves the custom agent's one-conversation invariant and makes queue state visible instead of superseding an undelivered instruction. It also defers while the user holds VM control. `VmManager.ensureRunning` joins a real boot and returns only when the VM is usable.

Running task completion is observed through the existing `projection_turns.pending_message_id` relationship. Terminal projection state finalizes the run, updates one-time task state after success, and emits a deduplicated notification.

## Agent authority

The `agent_workspace` MCP tool is guarded by the `vm` invocation capability. It derives the caller from the credential-bound thread through `VmAgentStore.getByThreadId`; callers cannot supply another agent id. Agent-created recurrence requires user approval. Artifact input is decoded against the declarative contract before persistence.

## Client delivery

`packages/client-runtime` owns the environment-scoped workspace stream and serialized mutation commands. The web client renders Tasks, Artifact, and Inbox alongside the existing Chat and Computer surfaces. Desktop inherits the web surface through Electron. Browser notifications are a best-effort delivery channel; the persisted Inbox and workspace stream are authoritative for local, LAN, relay, and tunnel clients.

Bounded collaboration has a separate environment-scoped stream. A snapshot carries named-agent
capability and availability summaries plus delegation summaries. Detail is fetched only for the
selected delegation. Messages identify source agent, target agent, user, or system and preserve
pending/delivered state. Creation remains an agent/MCP action; clients observe, send bounded
follow-ups, cancel, and route human approvals back to the root thread.

Agent ids are always paired with an environment id in client routes. The server payload can omit the
environment because the selected connection already determines its authority boundary.
