# GPT-Live delegation transport

`liveSession.ts` implements the GPT-Live WebRTC/data-channel protocol independently of Realtime.
The shared voice-session factory selects it for `gpt-live-1`. Microphone input stays disabled until
`session.started`; no Realtime VAD or response commands cross this transport. Playback activity comes
from received audio, not text or backend generation. Stop disables capture first and waits for
`session.closed` before releasing the transport, with a bounded fallback for lost connections.

Authenticated, orchestration-scoped HTTP routes create a session using the server's OpenAI secret.
The browser receives an SDP answer and opaque session ID, never the permanent key. The server binds
the session to its authority. Session history and transcript context
are bounded. Transcript fragments alone do not start work: `session.delegation.created` triggers the
backend request and its opaque ID is retained for subsequent Live appends.

`OrchestratorLive` puts each request into the orchestrator's own thread as a `thread.turn.start`
message (`liveDelegationTask`), so no custom agent is involved. Its work id is `voice-turn:<message id>`;
`voiceWorkEvent` reads progress and completion from that thread's latest turn and the assistant
replies written after the request, the same reply rule `workspace_consult` uses. Per-session request
IDs and ordered sequences suppress retries and stale corrections; a correction is another message,
which steers into the running turn. NDJSON streams follow the thread's domain events and end at a
terminal status. Disconnecting a reader never cancels the work. New voice sessions do not
automatically reissue earlier requests.

Thinking appends carry progress; commentary appends carry results and questions. An append being
accepted is not evidence that audio played or that work finished. Session usage is cumulative seconds,
merged by session ID, with finality recorded only from a valid `session.closed` usage receipt. This
client ledger is separate from Realtime token estimates and backend provider usage.

The interface applies to web and Electron, including web clients connected to remote environments.
Native mobile does not currently host the Orchestrator WebRTC session. Shared contracts and persisted
settings accept GPT-Live without changing native mobile's existing chat behavior.
