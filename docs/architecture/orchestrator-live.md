# GPT-Live delegation transport

`liveSession.ts` implements the GPT-Live WebRTC/data-channel protocol independently of Realtime.
The shared voice-session factory selects it for `gpt-live-1`. Microphone input stays disabled until
`session.started`; no Realtime VAD or response commands cross this transport. Playback activity comes
from received audio, not text or backend generation. Stop disables capture first and waits for
`session.closed` before releasing the transport, with a bounded fallback for lost connections.

Authenticated, orchestration-scoped HTTP routes create a session using the server's OpenAI secret.
The browser receives an SDP answer and opaque session ID, never the permanent key. The server binds
the session to the configured assistant agent and authority. Session history and transcript context
are bounded. Transcript fragments alone do not start work: `session.delegation.created` triggers the
backend request and its opaque ID is retained for subsequent Live appends.

`OrchestratorLive` bridges requests into `VmAgentCollaboration` and wakes `VmAgentTaskScheduler`.
Ephemeral workers inherit the source agent's model and workspace. Per-session request IDs and ordered
sequences suppress retries and stale corrections; a correction goes to the active worker. Durable
idempotency keys prevent duplicate task creation. NDJSON streams follow collaboration revisions using
subscription receipts and release their subscriptions when disconnected. Disconnecting a reader
never cancels a task. New voice sessions do not automatically reissue earlier tasks.

Corrections are accepted while a worker is queued. The scheduler supplies all pending updates in
order in the same worker turn and marks them delivered only after dispatch. A new worker also keeps
the original task, so an early correction cannot discard its scope. Approval gates remain enforced.

Thinking appends carry progress; commentary appends carry results and questions. An append being
accepted is not evidence that audio played or that work finished. Session usage is cumulative seconds,
merged by session ID, with finality recorded only from a valid `session.closed` usage receipt. This
client ledger is separate from Realtime token estimates and backend provider usage.

The interface applies to web and Electron, including web clients connected to remote environments.
Native mobile does not currently host the Orchestrator WebRTC session. Shared contracts and persisted
settings accept GPT-Live without changing native mobile's existing chat behavior.
