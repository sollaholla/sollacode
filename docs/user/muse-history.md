# Muse work history

Reconnecting or resuming Muse can recover work that its native session already
recorded. Recovered tool calls and reasoning update their existing work-log rows
without moving them into the newest work group. Missing rows are inserted, using
the native recording time when available. This recovery does not run those tool
calls again.

The server also repairs chronology previously shifted by a replay. It matches
existing Muse rows to their earliest durable receipt with the same content,
restores their time and ordering, and retains their current results and status.
The repair runs once at startup; it does not send a prompt or resume model work.
