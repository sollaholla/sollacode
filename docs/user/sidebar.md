# Sidebar

## Settling a thread

Settle moves a completed thread out of the active list and into the **Settled** section. Solla Code
asks for confirmation before settling from a row, a context menu, or a multi-thread selection.
Canceling the dialog leaves the thread and the current selection unchanged. A settled thread can be
returned to the active list with **Un-settle**.

Dedicated agent, Orchestrator, and Agent Builder chats stay active permanently. They do not settle
after inactivity, on a closed or merged pull request, or through a Settle action.
This also applies to older Agent Creator chats. Any old settled classification
is ignored when opening these persistent chats.

Archive, unarchive, settle, and un-settle remain available while a remote computer is offline.
Solla Code stores the latest choice for each thread and sends it when that environment reconnects;
reversing the choice before reconnect replaces the pending action instead of replaying both.

## Read and unread

Opening a chat marks its current activity as read. A completion or snooze wake while the chat is
open also clears its indicator. Streaming text does not repeatedly mark it read, so **Mark unread**
stays in effect until you reopen the chat, it starts or finishes another turn, or it wakes again.

## Reopening long chats

Web, desktop, and mobile save a recent window of each chat for reopening. Older messages stay on
the environment that owns the chat and load as you scroll back while connected. Saving the recent
window does not remove messages you are already reading. Offline, only the saved window is available.

After the cache format update, the first open needs a connection to refresh older saved copies.
Your conversation history on the owning environment is unchanged.
