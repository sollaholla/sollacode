# Sidebar

## Settling a thread

Settle moves a completed thread out of the active list and into the **Settled** section. Solla Code
asks for confirmation before settling from a row, a context menu, or a multi-thread selection.
Canceling the dialog leaves the thread and the current selection unchanged. A settled thread can be
returned to the active list with **Un-settle**.

Orchestrator and Agent Builder chats stay active permanently. They do not settle
after inactivity, on a closed or merged pull request, or through a Settle action.
This also applies to older Agent Creator chats. Any old settled classification
is ignored when opening these persistent chats.

Archive, unarchive, settle, and un-settle remain available while a remote computer is offline.
Solla Code stores the latest choice for each thread and sends it when that environment reconnects;
reversing the choice before reconnect replaces the pending action instead of replaying both.
