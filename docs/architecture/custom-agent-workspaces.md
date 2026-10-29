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
  The person's answer to an action approval (a message id starting
  `ACTION_APPROVAL_RESPONSE_MESSAGE_ID_PREFIX`, from
  [actionApproval.ts](../../packages/shared/src/actionApproval.ts)) also continues the work that
  asked (see below). A sender in the thread's own side-chat family stands for that chat's own
  senders as of its first message here (`readWorkSenders` with `asOf`: the work of the turn running
  then, `readTurnRunningAsOf`, and only messages up to then), so the family member's later work
  doesn't change it. Before an `ask`, the handler walks those senders from the caller and refuses a
  target already in the chain (a cycle) or a chain already three hops deep. A message from the
  orchestrator ends the chain, as the person.
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

`getTurnTrigger` also returns `workStartedAt`, when the current work began (`readWorkStart`). The
turn carrying the person's answer to an action approval (`action-approval-response:<requestId>`)
continues the work that raised that request: `readWorkStart` finds when the request's
`user-input.requested` activity was raised (among the thread's newest 256), takes the turn running
then (`readTurnRunningAsOf`), and reports that work's start, following at most 4 answers nested in
each other. It reads senders from the earlier of that start and the newest work begun since, so a
person or scheduled turn between the card and the answer neither drops another chat's provenance nor
makes the answer look like new work. When the 64-turn look-back (`TURN_PROVENANCE_TURN_LIMIT`) is all
continuations, the input of the newest work-starting turn among up to 512 earlier turns stands in,
read along the turns' `(thread_id, requested_at)` index (approval answers are excluded in SQL so they
never use up its 8 candidates), else the oldest of those 512, so a sender in reach is never missed. `ActionApprovalBroker` keeps `workStartedAt` with each open card, and when the person
approves one it remembers the proposal's fingerprint per thread with that work (in memory, at most
256). One identical re-request in the same work then returns `approved` (`approvalMode: "user"`)
without a second card and uses the approval up, checked after the Agent-mode rule and before
reusing an open card; a later repeat, new work, corrections, cancellations and a server restart ask
again.

## Call transfer and merged calls

An [agent call](../reference/encyclopedia.md#agent-call) is one GPT-Live voice pinned to the called
agent's main chat. With client delegation GPT-Live has no tools, so the voice acts the way a spoken
goodbye hangs up (`orchestrator/farewell.ts`): the device holding the call teaches the voice exact
phrases and acts on the flushed assistant transcript with `readCallDirectives`
([callDirectives.ts](../../apps/web/src/agentCall/callDirectives.ts)). Each phrase must open its
sentence, at most after two short acknowledgements ("Sure, …", "Okay — …"), so a refusal ("I won't
be transferring you to Gregg.") or a reply read out ("…, adding logging to the call.") is none:

- `Transferring you to <Name>.` and nothing after it. It counts only when it ends the utterance,
  and not as a question.
- `Adding <Name> to the call.` and `Removing <Name> from the call.`: every one in the run of
  phrases that ends the utterance, in order, including ones joined with "and" ("Adding Gregg to the
  call, and adding Nova to the call."). Not a question. One phrase may name several people
  ("Adding Gregg and Nova to the call."), though the voice is told to say one per person.

The pure rules live in [agentCallGroup.ts](../../apps/server/src/vm/agentCallGroup.ts);
`AgentCallLive` ([AgentCallLive.ts](../../apps/server/src/vm/AgentCallLive.ts)) does the I/O.

**Roster.** `callRoster` runs once in `AgentCallLive.start`, from the agent list and the shell
snapshot (empty when either read fails), and is kept on the session. It lists the host's other
agents that are not stopped and have a chat, then at most 12 of the most recently updated chats,
skipping archived chats, side chats, the orchestrator, Agent Builder, `delegation-worker:*` threads
and agents' main chats. It holds at most 30 entries and 1,500 characters of names, cuts names to 100
characters, and drops a name that compares equal (`spokenKey`: case, accents and punctuation
ignored) to one already listed or to the called agent, so agents win. `agentCallInstructions`, the
session's immutable GPT-Live instructions, never mention it. `vmAgent.call.roster`
(`AuthVmOperateScope`) returns the session's roster, or `AgentCallError` "This call has ended." when
no live session holds the call. The device fetches it once the call is live and appends
`callRosterInstructions` as silent instructions (`VoiceSession.instruct`,
`session.instructions.append`), one append per line: the phrase lines first (the transfer lines
only with agents), then the names, split between names so each line fits one 480-byte append
(`LIVE_APPEND_CHUNK_BYTES`). A device that can't act on the phrases never teaches them, so an older
client's voice never offers a transfer, and a host without the method leaves the roster empty and
the voice untaught.

Names the voice says resolve with `resolveSpokenNames`: `resolveRosterName` exact ignoring case,
accents and punctuation, else the one entry within one edit; also without a leading "the" or a
trailing "chat" or "thread"; a name that fits nobody is read as a list split on "and" and commas.
Voice names never match by prefix (`resolveRosterName`'s `prefix` option is off), so a word from a
reply can't land on a chat that starts with it. A transfer resolves against the roster's agents and
needs exactly one, other than the called agent; otherwise nothing happens. An add resolves against
the roster and skips anyone already on the call; a remove resolves against the call's participants.
A name that fits nobody shows "No one called <Name> is on the call list." (add) or "<Name> isn't on
this call." (remove) on the call screen, and tells the voice to tell the person and ask who they
meant.

**Transfer** is client-only; the host has no transfer request. The device sets `transferringTo`
(the screen reads "Transferring to <Name>…"), lets the voice finish (`endAfterReply`), and once the
session goes quiet (`completeTransfer`) ends the old call with a plain end and no hang-up tone or
ended screen, posts `released` for it with `agentCallTransferDetail(<agent>)` as its detail
([agentCallBridge.ts](../../packages/shared/src/agentCallBridge.ts)), then places an outgoing call
to the agent the way `place()` does, posting `held` and `connected`. If the host ends the call
first (another device's End, the agent deleted), the transfer is dropped. The new call carries
`transferredFrom`: if the host refuses to place it, the page posts `failed` against the old call id
at once, before the new session gives up opening the microphone, so the phone screen stays open on
the reason. A `/call` page showing the old call replaces its route with the new call's. The phone's
`AgentCallRouteScreen` follows whichever call the page last held; `previousFollowedStatus`
([agentCallModel.ts](../../apps/mobile/src/features/agentCalls/agentCallModel.ts)) keeps the new
call's first status from reading as a change. While the release's transfer is in flight
(`AgentCallScreenHold.transfer`), the old call's ending waits `AGENT_CALL_HOLD_GRACE_MS` (5 s) for
`held` or `failed` instead of the 1.5 s "Call ended" linger, and leaving the screen cancels the
outgoing ring to that agent if the host's snapshot shows it (the host allows one open call per
agent); left before the snapshot shows it, that ring runs out on its own. Leaving after `held` ends
or cancels the new call.

**Participants.** `AgentCall.participants` lists the chats added to a call, oldest first; this host
always sends it (`[]` by default), older hosts omit it. `vmAgent.call.addParticipant` and
`vmAgent.call.removeParticipant` (`AuthVmOperateScope`) go through `AgentCallLive`.
`callParticipantFor` checks the chat exists, isn't archived and isn't the orchestrator, Agent
Builder or a delegated worker, and names it: the agent's name for an agent's main chat, otherwise
the chat title. The `AgentCalls` store, which keeps participants in memory with the call, then
refuses a ringing call ("Answer the call before adding anyone."), a call that isn't active ("This
call has ended."), the called agent, a chat already on the call, and more than
`AGENT_CALL_MAX_PARTICIPANTS` (4). It broadcasts the call and keeps its lease. Removing is
idempotent. The device holding the call diffs participants by thread id (`callParticipantNotice`)
and tells the voice silently who joined or left (`VoiceSession.instruct`,
`session.instructions.append` in GPT-Live), once per change.

**Routing.** Per delegation, `callAddressing` (`callDelegationTargets` for just the targets) picks
the chats the new words go to, from the person's latest words only (`extractCallDelta`'s
`latestUserText`: the new user fragments after the last thing the voice said before them), so
words the voice handled without delegating ("Add Gregg to the call.", "Thanks, everyone.") never
route later ones; the message still carries everything new. With no participants it is the called
agent, exactly as before. Otherwise:

- Every chat on the call named in the words: whole words, ignoring case, accents and punctuation.
  A name said only inside a longer name on the call ("Atlas" in "Atlas migration") doesn't count.
  An agent whose name has two or more words also matches by its first word when that word has 4+
  letters and no other name on the call shares it; a chat needs its whole title. A name of 4+
  letters also matches with one slip ("Greg" for "Gregg") where the person addresses someone
  (opening a sentence after lead-in words, or set off by commas) when no other name fits.
- Everyone when the person speaks to the group (`addressesEveryone`). "All of you", "both of you",
  "all two/three/four/five of you", "y'all", "you guys" and "you all" (not "you all
  set/right/ready…") count anywhere; "you two" and "you three" after a verb ("can you two …") or
  closing a phrase. "Everyone", "everybody", "guys" and "folks" count only when said to the call:
  opening a sentence as its own words (after up to two lead-ins) and followed by punctuation, a
  question word or (for "everyone" and "everybody") a question; after a greeting ("Okay everyone
  listen up"); after a comma and closing a phrase ("…, everybody?"); or ending a greeting, a
  thank-you or a question ("Thanks everyone", "what do you think everyone"). "Does/is/are …
  everyone" counts too, unless what was said opens with a name on the call or the sentence limits
  who ("everyone on the team").
- Nobody named: the called agent, unless `asking` holds exactly one chat on the call and it is a
  participant. Each delegation builds `asking` only from participants the previous words went to
  (`lastDelivery`) and those whose question the call read out since, plus the called agent, keeping
  the ones with an open question a spoken answer can fill (at most 5 chats read). So a question a
  chat had open before it joined, one the person talked past, or an approval doesn't pull the
  person's words to it.
- At most 1 + `AGENT_CALL_MAX_PARTICIPANTS` targets.

Each target gets what the called agent gets: `thread.user-input.respond` for an open question a
spoken answer can fill, otherwise `thread.turn.start` with `inputOrigin: "transcription"` and no
`senderThreadId`. The person spoke to that chat and added it to the call, so its provenance is the
person's. While the call has participants, every message ends with `groupCallNote` ("(Group call:
you're on a call with the person and …)"), and a participant's quotes the voice as "(On the call
<Agent> replied: …)" rather than "I replied", since the voice isn't its own. Message and command ids
hash the session and delegation, plus the thread for a participant, so with no participants ids and
text are as before. A retried delegation id reattaches to the chats it first followed. A target
that refuses the dispatch reads "<Name> couldn't answer: My chat didn't get that."; the delegation
fails with 502 only when no target got the words.

**Replies.** A delegation that follows only the called agent streams that chat's events unchanged.
Otherwise each target has its own `watch`, merged by `mergeCallWorkEvents` into one
`OrchestratorLiveWorkEvent` stream, and each reply is read out as it lands:

- A target that finishes while others still work is read out at once in an audible `waiting-input`
  event, "Name: …" ending "Not done yet: <names>.", followed by a quiet progress event (`running`
  or `queued`).
- A question or approval from any target surfaces at once, prefixed with its name, after any
  replies not heard yet. Its watch cuts only the request's own text to the share, so the closing
  instruction ("please approve or decline it in Solla Code; a spoken yes can't approve it") always
  survives.
- While the only targets not done wait on the person for what the call already heard, a quiet
  `waiting-input` event with no text says nobody is working.
- Once every target is terminal, the replies not heard yet, "Name: …" each, joined by blank lines.
  Each reply is cut to `callReplyShare`, so the whole, names included, fits
  `SPOKEN_REPLY_MAX_CHARS`. A failure reads "<Name> couldn't answer: …", and the status is `failed`
  only when every target failed.

Later delegations keep following (carry) targets whose reply has not gone out, since the device
reads only its newest delegation's stream. A reply or request counts as heard (`Hearing`) only when
the stream that sent it was the newest delegation to reach the host; and a newer delegation
arriving within `HEARD_GRACE_MS` (2.5 s) takes back what older streams sent just before, because
the device switches streams as soon as GPT-Live starts a delegation, before it reaches the host. A
repeat is preferred to a drop. Before dispatching newer words to the same chat, a finished
unheard answer is captured and emitted as commentary on the new stream, before its new work.
A delegation whose words have not arrived yet ends quietly
(`completed`, empty text) so the device asks again once the transcript settles. Asked again still
without words, or arriving out of order, it follows only targets nobody has heard from yet (no
reply out, no question read out), ends quietly when none are left, and with no earlier work says
"I didn't catch a new request."

A participant whose chat is gone, when the words are sent or later while its reply is awaited, is
removed from the call and reads "<Name> couldn't answer: My chat is no longer available, so I've
left the call." Only the called agent's chat being gone when words are sent fails the call.

## Call sound

An agent call's voice session (`createLiveVoiceSession` with `phoneLine`, from the per-device
`callPhoneLine` client setting) plays the remote track through `createPhoneLine`
([phoneLine.ts](../../apps/web/src/orchestrator/phoneLine.ts)) on the session's own AudioContext:
two high-pass and two low-pass biquads (300 Hz to 3.4 kHz), a presence bump, a compressor, make-up
gain and a `tanh` soft clip bounded at full scale. The `<audio>` element keeps playing the track,
muted, because Chrome only feeds a remote WebRTC track to Web Audio while an element plays it; hush
mutes the line's output gain instead of the element. A line that fails to build leaves the element
playing as before.

`createDeskSounds` plays `deskBeats` into the same line while delegated work runs and the voice is
quiet, at the cue policy's volume (none when cues are off): bursts of 1.2 to 3.2 s of typing that end
on a whole word (typos backed out now and then), each followed by a 1 to 4 s pause, or by a click or
double-click with 0.6 s or more before it and 0.8 s or more before typing resumes. The session's
100 ms level meter pumps it, scheduling 0.35 s ahead on the context clock, so there is no extra
timer; each sound is filtered noise from one shared buffer. The phone app's call page is the web
page in a WebView, so it plays the same.

A call the person placed rings out (`startRingback` in
[ringtone.ts](../../apps/web/src/agentCall/ringtone.ts), 440 + 480 Hz, two seconds on and four
off) from `placing` until the voice connects (`isRingingOut`), and the voice is then told to pick up
with a short hello (`outgoingCallGreeting`), as `agentCallInstructions` also says for outgoing
calls; an incoming call's voice opens with why it rang.

**Voices.** `VmAgent.voice` (the `vm_agents.voice` column, migration 085) holds a voice chosen with
`vmAgent.voice.set` (`AuthVmOperateScope`) or Agent Builder's `set_voice`; null is automatic.
`agentCallVoice` ([agentCallVoice.ts](../../packages/shared/src/agentCallVoice.ts)) resolves it on
the host when a call's GPT-Live session is created, and in the web and phone pickers: a chosen voice
GPT-Live still lists, else the English voice at the agent's `avatarColor` (an id hash for agents
without one) in an order that alternates accent and presentation, starting with `marin`. Characters
are unique, so the first eleven agents never share a voice. The orchestrator's own voice setting no
longer decides a call's. The record's field is a plain string so a voice a client does not know
never fails the agent list; the set request takes only `OPENAI_LIVE_VOICES`.

## Grok Voice calls

An agent whose voice is one of xAI's (`agentCallEngine` in
[agentCallVoice.ts](../../packages/shared/src/agentCallVoice.ts): no voice name belongs to both
engines) is called on Grok Voice. The device decides from the agent record (`AgentCallParty.engine`)
and posts `{ callId, history }` to `AGENT_CALL_GROK_SESSION_PATH`. `AgentCallLive.startGrok` shares
`claimFor` with the GPT-Live start (agent, the engine's key, session cap, claim, roster,
`agentCallInstructions` with `engine: "grok"`) and `keepSession`, then mints a short-lived xAI
client secret with `mintRealtimeToken` and returns it with the instructions; the session id is the
host's own (`grok-call-…`). Whichever engine a device asks for, the host serves it in that engine's
voice for the agent (`agentCallVoiceOn`), so a device that started before the voice changed still
connects. Placing and ringing check the key the agent's engine needs (`AgentCalls.callKeyConfigured`).

On the device, `createGrokCallSession`
([grokCallSession.ts](../../apps/web/src/agentCall/grokCallSession.ts)) runs the orchestrator's
realtime session over xAI's WebSocket with a `realtimeCall` start: the call's instructions and one
tool, `ask_your_chat` (`AGENT_CALL_GROK_DELEGATE_TOOL`), in place of the orchestrator's, no state
cues, and `toolReplyInstructions` so the voice says it passed the request on rather than inventing a
result. A tool call starts a delegation exactly like GPT-Live's: finished transcripts become timed
context fragments, the host's delegation route works out what is new, and audible work events
(terminal, waiting on the person, an approval) are spoken with `announce`. Heartbeat, release (on
stop, on the voice ending itself, and on `pagehide`), goodbye hang-up from both sides' transcripts,
`instruct` (a `session.update` that grows the instructions), `setMuted` (the PCM send gate) and the
phone line (`playbackDestination`) and desk follow the GPT-Live call's behaviour. Usage goes to the
orchestrator's voice usage ledger (`appendUsage`). `setMicrophone` is not supported on this transport.
