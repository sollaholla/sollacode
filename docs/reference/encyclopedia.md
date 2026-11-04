# Encyclopedia

This is a living glossary for Solla Code. It explains what common terms mean in this codebase.

## Table of contents

- [Project and workspace](#project-and-workspace)
- [Thread timeline](#thread-timeline)
- [Orchestration](#orchestration)
- [Provider runtime](#provider-runtime)
- [Custom agents](#custom-agents)
- [Checkpointing](#checkpointing)
- [Orchestrator voice](#orchestrator-voice)

## Concepts

### Project and workspace

#### Project

The top-level workspace record in the app. In [the orchestration contracts][1], a project has a `workspaceRoot`, a title, and one or more threads. See [workspace-layout.md][2].

#### Project statistics

What a project keeps and has used, for Settings → Projects: chat and turn counts, storage, and token usage per day and per provider. The server assembles it on request (`orchestration.getProjectStatistics`, [projectStatistics.ts](../../apps/server/src/orchestration/projectStatistics.ts)) from the thread storage counters, artifact sizes, the attachments directory, and turn usage activities. Clients join it onto the live project list with [projectStatistics.ts](../../packages/client-runtime/src/state/projectStatistics.ts). See [projects.md](../user/projects.md).

#### Project folder usage

A project folder's size on disk, for Settings → Projects. [ProjectFolderUsage.ts](../../apps/server/src/project/ProjectFolderUsage.ts) walks folders one at a time in a worker thread (same volume, symlinks not followed, hard links once), keeps each total for six hours, measures deepest folders first so a folder holding others reuses their totals, and on macOS without Full Disk Access leaves out the folders a walk would raise privacy prompts for. Clients subscribe with `orchestration.subscribeProjectFolders` and re-measure with `orchestration.measureProjectFolders`. See [projects.md](../user/projects.md).

#### Image thumbnails

A small JPEG of an image asset, asked for with `thumbnail=1` on its signed URL and made by macOS's `sips` in [ImageThumbnails.ts](../../apps/server/src/assets/ImageThumbnails.ts), cached by the file's size and modification time. Thumbnail tiles use them; viewers fetch the original. Other hosts, and files of 96 KB or less, get the original. See [image-previews.md](../user/image-previews.md).

#### Thread file link

A 15-minute signed URL for one file outside a thread's workspace, for devices the file viewer's cookie can't reach. The host issues it only when an assistant message in that thread names the exact path, in [ThreadAssetAuthorization.ts](../../apps/server/src/assets/ThreadAssetAuthorization.ts), and serves it under the viewer's rules, so text never renders as a document.

#### Database compaction

Rewriting an environment's `state.sqlite` without its free pages, which SQLite reuses but never returns to the disk. A person schedules it from Settings → General → Storage (`server.scheduleDatabaseCompaction`, `server.cancelDatabaseCompaction`, `server.getDatabaseStorage`); the request is a file beside the database, and the next server start runs it in [DatabaseCompaction.ts](../../apps/server/src/persistence/DatabaseCompaction.ts) before the SQLite client opens the file: exclusivity proof (leaving WAL mode), `VACUUM INTO` a copy in a worker thread ([DatabaseCompactionWorker.ts](../../apps/server/src/persistence/DatabaseCompactionWorker.ts)), `quick_check` plus schema and row-count comparison, then one rename. Launches made by the app updater carry `--solla-update-launch=` and defer it. See [storage.md](../user/storage.md#compacting-the-database).

#### Thread storage counters

`projection_thread_storage`: per-thread counts and byte sizes of stored messages and activities, kept exact by SQLite triggers on every insert, update, and delete so storage can be reported without reading gigabytes of history. Created and backfilled by [082_ProjectionThreadStorage.ts](../../apps/server/src/persistence/Migrations/082_ProjectionThreadStorage.ts); a thread's row goes with its `projection_threads` row ([083_ProjectionThreadStorageCleanup.ts](../../apps/server/src/persistence/Migrations/083_ProjectionThreadStorageCleanup.ts)).

#### Workspace root

The root filesystem path for a project. In [the orchestration model][1], it is the base directory for branches and optional worktrees. See [workspace-layout.md][2].

#### Worktree

A Git worktree used as an isolated workspace for a thread. If a thread has a `worktreePath` in [the contracts][1], it runs there instead of in the main working tree. Git operations live in [GitManager.ts][3].

### Thread timeline

#### Thread

The main durable unit of conversation and workspace history. In [the orchestration contracts][1], a thread holds messages, activities, checkpoints, and session-related state. See [projector.ts][4].

#### Turn

A single user-to-assistant work cycle inside a thread. It starts with user input and ends when follow-up work like checkpointing settles. See [the contracts][1], [ProviderRuntimeIngestion.ts][5], and [CheckpointReactor.ts][6].

#### Activity

A user-visible log item attached to a thread. In [the contracts][1], activities cover important non-message events like approvals, tool actions, and failures. They are projected into thread state in [projector.ts][4].

#### Thread image gallery

Every image a conversation shows, oldest first and each once, which the enlarged image viewer pages through. Message attachments are named `message-attachment:<id>` and work-log images by `workLogImageId` (`file:`, `attachment:`, `stored:`), so any card can open the gallery on its own image. [threadImages.ts](../../packages/client-runtime/src/state/threadImages.ts) maps each image to bytes in hand or an asset to fetch; web walks timeline entries in [timelineImageGallery.ts](../../apps/web/src/components/chat/timelineImageGallery.ts) and mobile walks the feed in [threadImageGallery.ts](../../apps/mobile/src/features/threads/threadImageGallery.ts). Both collect the list only when an image is opened, and the viewers fetch assets as they come up. See [image-previews.md](../user/image-previews.md).

### Orchestration

Orchestration is the server-side domain layer that turns runtime activity into stable app state. The main entry point is [OrchestrationEngine.ts][7], with core logic in [decider.ts][8] and [projector.ts][4].

#### Aggregate

The domain object a command or event belongs to. In [the contracts][1], that is usually `project` or `thread`. See [decider.ts][8].

#### Command

A typed request to change domain state. In [the contracts][1], commands are validated in [commandInvariants.ts][9] and turned into events by [decider.ts][8].
Examples include `thread.create`, `thread.turn.start`, and `thread.checkpoint.revert`.

#### Domain Event

A persisted fact that something already happened. In [the contracts][1], events are the source of truth, and [projector.ts][4] shows how they are applied.
Examples include `thread.created`, `thread.message-sent`, and `thread.turn-diff-completed`.

#### Decider

The pure orchestration logic that turns commands plus current state into events. The core implementation is in [decider.ts][8], with preconditions in [commandInvariants.ts][9].

#### Projection

A read-optimized view derived from events. See [projector.ts][4], [ProjectionPipeline.ts][11], and [ProjectionSnapshotQuery.ts][10].

#### Projector

The logic that applies domain events to the read model or projection tables. See [projector.ts][4] and [ProjectionPipeline.ts][11].

#### Read model

The current materialized view of orchestration state. In [the contracts][1], it holds projects, threads, messages, activities, checkpoints, and session state. See [ProjectionSnapshotQuery.ts][10] and [OrchestrationEngine.ts][7].

#### Reactor

A side-effecting service that handles follow-up work after events or runtime signals. Examples include [CheckpointReactor.ts][6], [ProviderCommandReactor.ts][12], and [ProviderRuntimeIngestion.ts][5].

#### Receipt

A lightweight typed runtime signal emitted when an async milestone completes. See [RuntimeReceiptBus.ts][13].
Examples include `checkpoint.baseline.captured`, `checkpoint.diff.finalized`, and `turn.processing.quiesced`, which are emitted by flows such as [CheckpointReactor.ts][6].

#### Quiesced

"Quiesced" means a turn has gone quiet and stable. In [the receipt schema][13], it means the follow-up work has settled, including work in [CheckpointReactor.ts][6].

#### Live feed

The stream behind the [Live Inspector](../user/live-inspector.md). [LiveFeed.ts](../../apps/server/src/orchestration/LiveFeed.ts) watches domain events and turns the ones a person would notice into **beats**: one plain line each (`kind`, `title`, `detail`), such as a command run, a file read or edited, the words an agent said, a question, or an error. A tool's output is never read. A running tool and its completion share one beat, as does a reply as it is written; a beat still under way is `live`. The server keeps the latest 160 in memory and sends them as one snapshot, then each new or changed beat (`orchestration.subscribeLiveFeed`). Clients fold the feed with [liveFeed.ts](../../packages/shared/src/liveFeed.ts).

### Provider runtime

The live backend agent implementation and its event stream. The main service is [ProviderService.ts][14], the adapter contract is [ProviderAdapter.ts][15], and the overview is in [provider-architecture.md][16].

#### Provider

The backend agent runtime that actually performs work. Built-in drivers currently include Codex, Claude, Cursor, Grok, OpenCode, Antigravity, Deep Code, and the MCP bridge. See [ProviderService.ts][14], [ProviderAdapter.ts][15], and [CodexAdapter.ts][17].

#### First-run setup

The full-window screens a new environment with no projects shows on its landing page: choose which providers to turn on, install or sign in to each, set a few preferences, then a six-step welcome tour. Finishing or skipping stores `providerSetupVersion` and `welcomeTourVersion` in server settings, so each opens once per environment, not per device; only the tour's resume position is per device. See [ProviderSetup.tsx](../../apps/web/src/components/onboarding/ProviderSetup.tsx), [WelcomeFlow.tsx](../../apps/web/src/components/onboarding/WelcomeFlow.tsx), and [first-run-setup.md](../user/first-run-setup.md).

#### Devices

iOS simulators and Android emulators on the environment's machine, managed in Settings → Devices and opened live in a browser tab. The server's [DeviceManager.ts](../../apps/server/src/devices/DeviceManager.ts) drives `xcrun simctl` and serve-sim for iOS, and the Android SDK's adb, emulator, and avdmanager plus the emulator's gRPC control port for Android, served by a token-gated loopback viewer ([androidViewer.ts](../../apps/server/src/devices/androidViewer.ts)). See [devices.md](../user/devices.md).

#### Session

The live provider-backed runtime attached to a thread. Session shape is in [the orchestration contracts][1], and lifecycle is managed in [ProviderService.ts][14].

#### Runtime mode

The safety/access mode for a thread or session. In [the contracts][1], the values are `approval-required`, `auto-accept-edits`, `auto`, and `full-access`. See [runtime-modes.md][18].

#### Interaction mode

The agent interaction style for a thread. In [the contracts][1], the values are `default`, `plan`, and `agent`. See [runtime-modes.md][18].

#### Proposed plan

A plan an agent asks the person to approve (Claude's ExitPlanMode, a Codex plan item, Cursor's `create_plan`, or a `<proposed_plan>` block in Grok, Muse, Deep Code, OpenCode or Antigravity text, read by [proposedPlanBlocks.ts](../../apps/server/src/provider/proposedPlanBlocks.ts)), stored per plan with `implementedAt` and `closedAt`. The thread waits on its newest plan while both are unset; older plans are implemented, closed, or superseded. The decider settles it when the person (or the orchestrator relaying them) answers in Build or Agent; housekeeping, resumes, delegated runs and other agents never do. The person can also close it without answering (`thread.proposed-plan.close`, undone by `thread.proposed-plan.reopen`). Reverting the answering turn reopens it. One rule for every surface: [proposedPlans.ts](../../packages/shared/src/proposedPlans.ts). Not a task list.

#### Task list

The agent's progress checklist (TodoWrite, Claude Tasks, Codex update_plan, Cursor todos, a refresh), carried by `turn.plan.updated` activities despite the name. Shown in the plan panel's Tasks section, never as a proposed plan's steps. See [taskLists.ts](../../packages/shared/src/taskLists.ts).

#### Background task

Work a provider runs outside the turn that started it: a sub-agent, workflow, monitor, or backgrounded command, announced through `task.started`/`task.progress`/`task.completed` activities. Each thread summary carries `backgroundTasks`, the open tasks that reported within 30 minutes of the newest report, projected by `BackgroundTaskProjection.ts`. Clients treat the thread as working while that summary is live (`liveBackgroundTasks` in client-runtime), and the server marks every task a previous process left open as stopped when it boots. See [provider-background-tasks.md](../user/provider-background-tasks.md).

#### Turn usage

The tokens one turn used, attached to the provider's `turn.completed` event as `turnUsage` and stored as a hidden `turn.usage` activity that project statistics sum. Claude measures it as the growth in the session's cumulative `modelUsage` and `total_cost_usd` ([claudeTurnUsage.ts](../../apps/server/src/provider/claudeTurnUsage.ts)); Codex as the growth in the thread's token total across the turn ([codexTurnUsage.ts](../../apps/server/src/provider/codexTurnUsage.ts)). Other providers report none yet. Never shown in the transcript.

#### Assistant delivery mode

Controls how assistant text reaches the thread timeline. In [the contracts][1], `streaming` updates incrementally and `buffered` delivers a completed result. See [ProviderService.ts][14].

#### Thought chunk

An ACP `agent_thought_chunk` - the model's private reasoning before it writes assistant text. Grok 4.6 and Grok Build emit these for a long stretch at high effort. The adapter keeps them out of the assistant message and surfaces one collapsed "Thinking" activity so the chat is visibly proceeding. See [GrokAdapter.ts][29] and [AcpRuntimeModel.ts][30].

#### Usage limit reset

A provider-granted credit that clears the current usage limits on demand. Codex reports earned resets over its app-server; Claude's banked resets (`cedar_ember`) are read from the Claude OAuth usage endpoint with the CLI's stored sign-in and redeemed with an idempotent request id. Both reach clients as `rateLimitResetCredits` inside the provider's account usage and are redeemed through the driver's `usageReset` capability. See [ClaudeBankedResets.ts](../../apps/server/src/provider/Drivers/ClaudeBankedResets.ts) and [provider-usage.md](../user/provider-usage.md).

#### Snapshot

A point-in-time view of state. The word is used in multiple layers, including orchestration, provider, and checkpointing. See [ProjectionSnapshotQuery.ts][10], [ProviderAdapter.ts][15], and [CheckpointStore.ts][19].

### Custom agents

#### Custom agent

A named Agent Stack identity with one dedicated chat thread whose browser keeps persistent logins. It is not a generic provider agent or an ordinary project thread. See [the user guide](../user/custom-agents.md).

#### Browser profile

The cookies, logins, storage and cache a preview tab uses. A project's threads share one and each agent has its own, keyed by a scope hashed into a folder under `Partitions/`. `.t3-browser-profiles.json` records each folder's owner, and folders whose owner is gone are retired, then purged. See [Accounts and browser profiles](../user/accounts.md).

#### Credential vault

The desktop's store of saved website logins, PINs, and codes, managed in Settings → Accounts.
Each entry has a kind: a `password` fills only a password input, and a `code` (a PIN or similar)
also fills a single-line text, tel, number, or search input. Entries saved before kinds existed are
passwords. Secrets are encrypted by the operating system and are only ever decrypted in the Electron
main process, straight into an allowed field of a preview tab whose origin exactly matches the entry,
including a field inside a same-origin iframe. Agents see labels, usernames, kinds, and opaque IDs
through `preview_credentials` and fill with `preview_fill_credential`; the tab then masks that
secret in every snapshot, evaluation, and status it returns. Web and mobile
clients manage it remotely: the `previewCredentials.*` RPCs relay one list, save, or remove through
the preview automation broker to the environment's own desktop host, which registers with
`manageCredentials` (honoured only for the local desktop session). See
[BrowserCredentialVault.ts](../../apps/desktop/src/preview/BrowserCredentialVault.ts),
[RemoteCredentialVault.ts](../../apps/server/src/preview/RemoteCredentialVault.ts), and
[remote-browser-control.md](../user/remote-browser-control.md#saved-passwords-and-pins-for-agents).

#### Passkey vault

Passkeys Solla holds for sites a person turned on, in the desktop's `browser-passkeys.json` with their
private keys encrypted. A guest on such a site holds a `Passkeys` activity lease, which keeps its
debugger attached, and gets a CDP virtual authenticator again at every main-frame commit, because
Chromium keeps one per document. `WebAuthn.credential*` events are stopped before diagnostics and
kept here. See [BrowserPasskeyVault.ts](../../apps/desktop/src/preview/BrowserPasskeyVault.ts) and
[passkeyAuthenticator.ts](../../apps/desktop/src/preview/passkeyAuthenticator.ts).

#### Credential request

An agent's `preview_request_credentials` call: a durable `user-input.requested` activity carrying a
`credentialRequest` (origin read from the tab, mode `password`, `code`, `passkey`, or `person`, and the agent's
reason), which ends the turn. The card sends the secret straight to the
[credential vault](#credential-vault), `ephemeral` when not saved, and answers with only the entry's
id, so the follow-up turn tells the agent what to fill without any secret entering the thread. Agent
mode and voice calls never answer one. See
[credentialRequest.ts](../../packages/shared/src/credentialRequest.ts).

#### Media channel

The authenticated binary WebSocket at `/ws/media` used for remote-control video. An approved
session issues a single-use ticket for a publisher or subscriber; video packets travel separately
from control RPC. Viewer acknowledgements drive pacing and adaptive encoding. See
[streaming architecture](../architecture/streaming.md).

#### Remote frame stream

The browser preview's change-driven picture subscription. Viewers announce size and patch support;
the desktop sends a keyframe and changed rectangles through `preview.remoteFrames`. Native viewers
request whole pictures. The last viewer leaving releases capture demand. See
[streaming architecture](../architecture/streaming.md#browser-preview).

#### Tab audio relay

How a browser tab's sound reaches a remote viewer. Viewers open `preview.tabAudioWatch` for the tab
they show; the server's relay counts listeners per tab and sends the set of listened-to tabs as
`audioDemand` to every desktop browser host that registered with `streamsTabAudio`. The desktop
window that renders the tab captures it (Chromium tab capture, then Opus via WebCodecs) only while
it is listened to and audible, and publishes 100 ms batches with `preview.tabAudioPublish`. Silence
and closed viewers send nothing. See
[TabAudioRelay.ts](../../apps/server/src/preview/TabAudioRelay.ts),
[tabAudioStreamer.ts](../../apps/web/src/components/preview/tabAudioStreamer.ts),
[tabAudioPlayback.ts](../../apps/web/src/components/preview/tabAudioPlayback.ts), and
[remote-browser-control.md](../user/remote-browser-control.md#hearing-the-tab).

#### Agent task

A durable prompt owned by one custom agent. Tasks may be manual, one-time, or recurring. The server scheduler waits for that agent's dedicated conversation rather than creating a parallel session.

#### Agent artifact

The custom agent's single output surface. It may be schedule, metrics, checklist, table, timeline,
or cards data, or an HTML/CSS web view rendered in the same opaque sandbox as a thread web artifact.
It is not a thread artifact.

#### Cross-chat message

A message one chat sends into another chat or a custom agent's chat with `workspace_consult` `ask`,
which every chat credential (including terminal agent CLIs) can call. The delivered message carries
`senderThreadId` and `senderThreadTitle`, and the clients show it on the AI side with the sender's
name; a thread opened by `ask` with a project records `createdByThreadId`, and the sidebar names that
creator. Guards: no messages into the caller's own side-chat family, the orchestrator, Agent Builder
or delegated worker threads, or a stopped agent's chat; no target already up the sender chain, and
no chain past three hops (walked from the messages each turn received); 20 asks per chat per 10
minutes; at most 10 non-archived threads created per chat. A question into a busy chat joins its
running turn, except on providers without live steering (Kimi, Deep Code, Antigravity), where it
stops that turn and runs next. In Agent mode, a turn that received another chat's message, and the
continuations after it, ask the person before `request_action_approval` passes, and tasks they add
or change wait as drafts, like delegated work. Only the orchestrator types into threads with
`workspace_orchestration` `send_to_thread`. See
[cross-thread-messages.md](../user/cross-thread-messages.md) and
[custom-agent-workspaces.md](../architecture/custom-agent-workspaces.md#cross-chat-messages).

#### Agent delegation

A bounded collaboration work item whose persistent root asks a named same-environment agent or an
ephemeral worker for help. It records source, target, limits, messages, human-approval state, and a
completed result without turning the worker into another persistent root. Only agents delegate: the
root is a custom agent, acting from its own chat or one of its side chats. Other chats reach an
agent with a [cross-chat message](#cross-chat-message) instead.

#### Ephemeral sub-agent

A short-lived delegation target created for one bounded task. It is distinct from a named custom
agent, which retains a dedicated chat after the delegation ends.

#### Agent call

A [GPT-Live](#gpt-live) voice call between the person and one custom agent, which can bring
[call participants](#call-participant) onto it or hand the person on with a
[call transfer](#call-transfer). The `AgentCall` record
([agentCall.ts](../../packages/contracts/src/agentCall.ts)) has a `direction`: `outgoing` when the
person calls, `incoming` when the agent rings. Its `reason` is `user` for outgoing calls, and
`blocker`, `question`, `approval` or `request` (agent_workspace `call_user`) for incoming ones. Its
`status` goes `ringing` → `active` → `ended`, or ends as `declined`, `missed` (an incoming ring
nobody answered within `AGENT_CALL_RING_SECONDS`), or `failed` (voice never started, including an
outgoing call that never connected).

Calls are server memory, not persisted ([AgentCalls.ts](../../apps/server/src/vm/AgentCalls.ts)).
Every device follows them with `vmAgent.calls.subscribe` (open calls plus recently ended ones) and
changes them with `vmAgent.call.place`, `vmAgent.call.decline` and `vmAgent.call.end`; clients use
`vmAgentEnvironment.calls`, `placeCall`, `declineCall` and `endCall` from
[vmAgents.ts](../../packages/client-runtime/src/state/vmAgents.ts). The device on a live call reads
its [call roster](#call-roster) with `vmAgent.call.roster` (`callRoster`) and changes who else is on
it with `vmAgent.call.addParticipant` and `vmAgent.call.removeParticipant` (`addCallParticipant`,
`removeCallParticipant`). Rings are gated by the
`orchestrator.agentCalls` setting and a saved OpenAI key, with one open call per agent, a cooldown
between automatic rings and an hourly cap on `call_user`. `call_user` works from the agent's chat,
its side chats and its delegated workers, all as the agent; any other chat asks the agent with a
[cross-chat message](#cross-chat-message).

`vmAgent.call.end` takes `AgentCallEndInput`. A plain end settles a `ringing` or `active` call as
`ended`. With `ifRinging: true` the host ends it only while it still rings, so a device that never
connected can cancel its ring without hanging up a call another device answered. The web client
sends a plain end only for a call whose claim the host accepted, or for an explicit **End call** on
a call held elsewhere; the phone's call screen decides from its page's messages (below).
Deleting an agent ends its open calls.

Answering is a compare-and-set claim: `POST /api/agents/call/session` (`AGENT_CALL_SESSION_PATH`)
moves the call from `ringing` to `active` and creates the GPT-Live session with the agent's persona;
a second device gets HTTP 409. `/api/agents/call/delegation` forwards what was said since the last
delegation into the agent's own chat as a user message (or as the answer to the chat's pending
question) and streams the chat's progress back as `OrchestratorLiveWorkEvent`s. With
[call participants](#call-participant) it forwards to the chats the words are for and merges their
progress into one stream.
`/api/agents/call/session/release` frees the session and ends the call; the web client also sends it
when the page is hidden for good (`pagehide`).

An `active` call holds a lease. The device on the call renews it with
`/api/agents/call/session/heartbeat` (`AGENT_CALL_SESSION_HEARTBEAT_PATH`) every
`AGENT_CALL_HEARTBEAT_SECONDS`, and delegations renew it too. A call whose lease lapses
(`AGENT_CALL_LEASE_SECONDS`) ends, so a crashed tab or a killed app leaves nothing open; a 2-hour
cap remains as a backstop. A heartbeat or delegation answered with 409 tells the client its call is
gone.

The web page `/call/$environmentId/$callId` (`agentCallRoutePath`) is where call push notifications
and the phone app land; the phone hosts it with `?embedded=1` in a WebView
([AgentCallRouteScreen.tsx](../../apps/mobile/src/features/agentCalls/AgentCallRouteScreen.tsx)).
Inside the phone app the page posts `AgentCallNativeMessage`s (`held`, `connected`, `released`,
`failed` with a detail) to `window.ReactNativeWebView`; the native screen trusts only these to know
which calls the phone holds. `held` is posted as the page answers or joins, before its claim
reaches the host; `connected` once the host accepted that claim. When the screen closes, it sends a
plain end only for a `connected` call. A held call that hasn't connected, and a call the phone
placed that the page doesn't hold, are only cancelled with `ifRinging` while they can still be
ringing; a held incoming ring is left ringing on the other devices. The app's WebViews always
install a message handler, so every page in them sees `window.ReactNativeWebView` and leaves
incoming calls to the native observer instead of ringing itself.
See [custom-agents.md](../user/custom-agents.md#calling-an-agent) and
[web-push.md](../architecture/web-push.md).

#### Call roster

Who an [agent call](#agent-call)'s voice can transfer the person to or bring onto the call
(`AgentCallRoster`, entries `{name, threadId, vmAgentId}`). `callRoster` in
[agentCallGroup.ts](../../apps/server/src/vm/agentCallGroup.ts) builds it once when the call
connects: the host's other agents that aren't stopped and have a chat (`vmAgentId` set), then up
to 12 of the most recently updated chats that aren't archived, side chats, internal threads or
agents' main chats (`vmAgentId` null). It is bounded to 30 entries and 1,500 characters of names; a
name equal to one already listed or to the called agent's (case, accents and punctuation ignored)
is dropped, so agents win. The host keeps it on the call's session and never puts it in the voice's
instructions: `vmAgent.call.roster` returns it to the device holding the call once the call is
live, and that device teaches the voice the exact phrases and the names as silent instructions
(`callRosterInstructions`), resolves the names the voice transfers to or adds only against it
(`resolveSpokenNames` in [callDirectives.ts](../../apps/web/src/agentCall/callDirectives.ts)),
and fills the **Add** picker and the command palette's **Add someone to the call...** from it. A
device that can't act on the phrases never teaches them.
See
[custom-agent-workspaces.md](../architecture/custom-agent-workspaces.md#call-transfer-and-merged-calls).

#### Call participant

A chat on an [agent call](#agent-call) besides the agent called: another agent's main chat (named
by the agent) or a regular chat (named by its title). `AgentCall.participants` holds them
(`AgentCallParticipant`, at most `AGENT_CALL_MAX_PARTICIPANTS`, 4); `vmAgent.call.addParticipant`
and `vmAgent.call.removeParticipant` change them, from the call screen's **Add** picker and remove
buttons, the command palette, or the voice saying "Adding <Name> to the call." / "Removing <Name>
from the call." (once per person, or one phrase naming several). Only an active call takes
participants. The call keeps one voice, the called agent's. `callDelegationTargets` sends the
person's latest words to the chats named in them, to everyone when they speak to the group, else
to the called agent (or to the one participant waiting on their answer). Each target gets an
ordinary transcription message with a "(Group call: …)" line (or the words as the answer to its
open question), and `mergeCallWorkEvents` speaks each
reply back as "Name: …" as soon as it lands; a participant still working when the person says
something else is followed by the next delegation, so its reply is not lost. A participant whose
chat is deleted leaves the call; the call goes on.

#### Call transfer

The voice of an [agent call](#agent-call) handing the person to another agent. When it says
"Transferring you to <Name>." as its own sentence and nothing after it, the device holding the call
resolves the name against the agents in the [call roster](#call-roster), lets the voice finish,
ends the call quietly (a plain end, no hang-up tone, no ended screen) and places a new outgoing
call to that agent from the same device. It is client-side
([AgentCallProvider.tsx](../../apps/web/src/agentCall/AgentCallProvider.tsx)); the host sees an
ended call and a new one. In the phone app the page posts `released` for the old call, saying which
agent it is moving to (`agentCallTransferDetail` in
[agentCallBridge.ts](../../packages/shared/src/agentCallBridge.ts)), then `held` for the new one (or
`failed` against the old one with the reason), and the native call screen waits for it and follows
it. A `/call` page showing the old call moves to the new one. Participants stay behind.

#### Phone line

How an [agent call](#agent-call) sounds on a device with **Phone-line calls** on (the
`callPhoneLine` client setting, default on): the agent's voice is filtered to a handset's 300 Hz to
3.4 kHz band with light compression, and while the agent works in its chat its desk (bursts of a
couple of seconds of typing, pauses, clicks) plays down the same line at the sound-cue volume,
pausing while it speaks. [phoneLine.ts](../../apps/web/src/orchestrator/phoneLine.ts).

#### Call voice

The GPT-Live voice an agent speaks with on [agent calls](#agent-call): the one chosen for it
(`VmAgent.voice`, set from the agent's **Call voice** menu, the phone app's agent screen, or Agent
Builder's `set_voice`), else one from its character, so each agent sounds different. A Grok
voice puts the agent's calls on Grok Voice instead of GPT-Live.
[agentCallVoice.ts](../../packages/shared/src/agentCallVoice.ts),
[grokCallSession.ts](../../apps/web/src/agentCall/grokCallSession.ts).

### Thread artifacts

#### Thread artifact

A named, environment-local file bundle owned by an ordinary thread. It has a stable lowercase key,
a current revision, archive state, and an isolated preview. See [the user guide](../user/thread-artifacts.md).

#### Artifact revision

An immutable version of a thread artifact with an entry path, content type, byte and file counts,
and icon provenance. An open surface remains pinned to its selected revision until the user accepts
a newer one.

#### Artifact resource

The exact thread, artifact, revision, and path descriptor exchanged for a short-lived signed URL by
the connected environment. Clients persist the identity, never the signed URL.

### Orchestrator voice

The orchestrator can speak through more than one realtime backend. These are **voice providers**, not coding-agent providers.

The same orchestrator - voice tools on the client, and the reserved orchestrator thread via the
`workspace_orchestration` MCP toolkit - can list, read, and type into thread terminals that are
already open. It does not spawn a pane. Any chat can list and read them through the same toolkit,
and list, read and type into them with `thread_terminals`. Sending into threads and interrupting
turns (`send_to_thread`, `interrupt_thread`) stay with the orchestrator, as does the toolkit's own
`write_to_terminal`. See
[orchestrator.md](../user/orchestrator.md#terminals) and [terminal-mode.md](../user/terminal-mode.md).

#### OpenAI Realtime

The original voice backend. The server mints an ephemeral client secret; the browser opens a WebRTC session to `api.openai.com`. See [OrchestratorCredentials.ts][25] and [realtimeSession.ts][26].

#### GPT-Live

OpenAI's continuous voice model (`gpt-live-1`, `OPENAI_LIVE_MODEL`) and the default OpenAI voice
model. Unlike Realtime there is no ephemeral client key: the server creates each session at
`POST https://api.openai.com/v1/live/sessions` with the saved OpenAI key and returns the WebRTC
answer to the browser. The model hands work back to the client through delegations, which the
server turns into agent work. Used by the orchestrator
([OrchestratorLive.ts](../../apps/server/src/orchestrator/OrchestratorLive.ts)) and by
[agent calls](#agent-call); the browser side is
[liveSession.ts](../../apps/web/src/orchestrator/liveSession.ts).

#### Grok Voice (xAI)

xAI's Speech-to-Speech API. The server mints an ephemeral client secret at `POST /v1/realtime/client_secrets`; the browser opens `wss://api.x.ai/v1/realtime` with the `xai-client-secret.` subprotocol and streams PCM16. Catalog and capability flags live in [orchestratorVoice.ts][27]. Setup: [orchestrator-grok-voice.md][28].

#### Preferred microphone

The microphone voice uses on one device, for [agent calls](#agent-call) and the orchestrator. The
person picks it in **Settings → Orchestrator → Microphone** or from the small arrow on a call's
**Mute** button ([MicrophoneMenu.tsx](../../apps/web/src/components/agentCall/MicrophoneMenu.tsx)).
It is kept in that browser's local storage (`solla:voice-microphone`,
[microphones.ts](../../apps/web/src/orchestrator/microphones.ts)), so each device, and the phone
app's call page, has its own. **Default** (null) follows the system microphone and switches
mid-call when it changes, such as when headphones connect. A chosen microphone that is missing
falls back to the default instead of failing the session. Each voice session reads the choice when
it opens, and a choice made during a call switches that call's microphone. See
[custom-agents.md](../user/custom-agents.md#calling-an-agent).

### Relayed environments

#### Relayed environment

An environment a device reaches through another environment it is connected to: a phone on the Mac's Tailscale address sees the Windows machine the Mac's desktop app added. The host's desktop app publishes its saved connections (`relayedEnvironments.publish`, held in memory by [RelayedEnvironments.ts](../../apps/server/src/relay/RelayedEnvironments.ts)); clients follow `subscribeRelayedEnvironments` and register a `RelayConnectionTarget`. Requests go through `/api/relay/<environment id>` ([relayRoute.ts](../../apps/server/src/relay/relayRoute.ts)), checked against the caller's session on the host and signed with the host's credential. The `shareConnectedComputers` server setting turns it off. See [remote-access.md](../user/remote-access.md).

#### Connected computer

What an agent calls a relayed environment. `workspace_consult` reaches one with the credential the host already holds, through `POST /api/consult` on that computer ([remoteRoute.ts](../../apps/server/src/mcp/toolkits/consult/remoteRoute.ts)), which applies the same limits as a local call. A chat there is recorded here under `remote:<environment id>:<depth>:<thread id>` (`makeRemoteThreadId`), so it can never pass for a local chat. See [Messages between chats](../user/cross-thread-messages.md#chats-on-connected-computers).

### Color themes

#### Named color theme

A VS Code–style palette (Dracula, Nord, Dark High Contrast, …) that replaces Solla Light or Solla Dark on web and desktop. Each entry in [colorThemes.ts](../../apps/web/src/theme/colorThemes.ts) declares a compact palette, a Shiki `syntaxTheme` and 16 ANSI colors; `deriveColorThemeVariables` expands the palette into every CSS variable, which [useTheme.ts](../../apps/web/src/hooks/useTheme.ts) applies inline on `<html>` with `data-color-theme`. The theme's `kind` drives the `.dark` class. A JSON paint cached under `t3code:color-theme-paint` lets the pre-paint script in `index.html` color the page before the bundle loads. Components read the syntax theme as `useTheme().diffThemeName`. See [appearance.md](../user/appearance.md).

### Checkpointing

Checkpointing captures workspace state over time so the app can diff turns and restore earlier points. The main pieces are [CheckpointStore.ts][19], [CheckpointDiffQuery.ts][20], and [CheckpointReactor.ts][6].

#### Checkpoint

A saved snapshot of a thread workspace at a particular turn. In practice it is a hidden Git ref in [CheckpointStore.ts][19] plus a projected summary from [ProjectionCheckpoints.ts][21]. Capture and lifecycle work happen in [CheckpointReactor.ts][6].

#### Checkpoint ref

The durable identifier for a filesystem checkpoint, stored as a Git ref. It is typed in [the contracts][1], constructed in [Utils.ts][22], and used by [CheckpointStore.ts][19].

#### Checkpoint baseline

The starting checkpoint for diffing a thread timeline. This flow is surfaced through [RuntimeReceiptBus.ts][13], coordinated in [CheckpointReactor.ts][6], and supported by [Utils.ts][22].

#### Checkpoint diff

The patch difference between two checkpoints. Query logic lives in [CheckpointDiffQuery.ts][20], diff parsing lives in [Diffs.ts][23], and finalization is coordinated by [CheckpointReactor.ts][6].

#### Turn diff

The file patch and changed-file summary for one turn. It is usually computed in [CheckpointDiffQuery.ts][20], represented in [the contracts][1], and recorded into thread state by [projector.ts][4].

## Practical Shortcuts

- If you see `requested`, think "intent recorded".
- If you see `completed`, think "result applied".
- If you see `receipt`, think "async milestone signal".
- If you see `checkpoint`, think "workspace snapshot for diff/restore".
- If you see `quiesced`, think "all relevant follow-up work has gone idle".

## Related Docs

- [architecture.md][24]
- [provider-architecture.md][16]
- [runtime-modes.md][18]
- [workspace-layout.md][2]

[1]: ../../packages/contracts/src/orchestration.ts
[2]: ./workspace-layout.md
[3]: ../../apps/server/src/git/GitManager.ts
[4]: ../../apps/server/src/orchestration/projector.ts
[5]: ../../apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts
[6]: ../../apps/server/src/orchestration/Layers/CheckpointReactor.ts
[7]: ../../apps/server/src/orchestration/Layers/OrchestrationEngine.ts
[8]: ../../apps/server/src/orchestration/decider.ts
[9]: ../../apps/server/src/orchestration/commandInvariants.ts
[10]: ../../apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts
[11]: ../../apps/server/src/orchestration/Layers/ProjectionPipeline.ts
[12]: ../../apps/server/src/orchestration/Layers/ProviderCommandReactor.ts
[13]: ../../apps/server/src/orchestration/Services/RuntimeReceiptBus.ts
[14]: ../../apps/server/src/provider/Layers/ProviderService.ts
[15]: ../../apps/server/src/provider/Services/ProviderAdapter.ts
[16]: ../architecture/providers.md
[17]: ../../apps/server/src/provider/Layers/CodexAdapter.ts
[18]: ../architecture/runtime-modes.md
[19]: ../../apps/server/src/checkpointing/CheckpointStore.ts
[20]: ../../apps/server/src/checkpointing/CheckpointDiffQuery.ts
[21]: ../../apps/server/src/persistence/Services/ProjectionCheckpoints.ts
[22]: ../../apps/server/src/checkpointing/Utils.ts
[23]: ../../apps/server/src/checkpointing/Diffs.ts
[24]: ../architecture/overview.md
[25]: ../../apps/server/src/orchestrator/OrchestratorCredentials.ts
[26]: ../../apps/web/src/orchestrator/realtimeSession.ts
[27]: ../../packages/contracts/src/orchestratorVoice.ts
[28]: ../integrations/orchestrator-grok-voice.md
[29]: ../../apps/server/src/provider/Layers/GrokAdapter.ts
[30]: ../../apps/server/src/provider/acp/AcpRuntimeModel.ts
